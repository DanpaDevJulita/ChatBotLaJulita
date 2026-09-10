// Servidor local que imita la API de OpenRouter (formato OpenAI) para probar el bot
// sin necesitar conexión real ni gastar créditos. No es parte del bot — es una
// herramienta de desarrollo. Uso:
//   node scripts/mock-openrouter.mjs &
//   OPENROUTER_BASE_URL=http://localhost:8787/v1 OPENROUTER_API_KEY=test npm run chat:local
import http from "node:http";

const PORT = 8787;
let turn = 0;

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  const lastMessage = payload.messages[payload.messages.length - 1];

  res.setHeader("Content-Type", "application/json");

  // Llamada del orquestador (src/core/orchestrator/route.ts): fuerza tool_choice="enrutar".
  // Simulamos la decisión con reglas simples por palabra clave sobre el mensaje del
  // cliente, solo para poder probar el enrutamiento sin gastar créditos de IA.
  if (payload.tool_choice?.function?.name === "enrutar") {
    const userMsg = payload.messages.find((m) => m.role === "user")?.content ?? "";
    let agente = "informacion";
    if (/humano|persona|asesor/i.test(userMsg)) agente = "humano";
    else if (/pagar|pago|transferir|comprobante/i.test(userMsg)) agente = "pagos";
    else if (/reserv|disponib|fecha/i.test(userMsg)) agente = "reservas";

    res.end(
      JSON.stringify({
        id: "mock-route",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_route",
                  type: "function",
                  function: { name: "enrutar", arguments: JSON.stringify({ agente, motivo: "mock" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    );
    return;
  }

  if (lastMessage.role === "tool") {
    // Segunda vuelta: ya tenemos el resultado de la herramienta, respondemos con texto final.
    res.end(
      JSON.stringify({
        id: "mock-2",
        choices: [
          {
            message: {
              role: "assistant",
              content: `[MOCK] Recibí el resultado de la herramienta: ${lastMessage.content}`,
            },
            finish_reason: "stop",
          },
        ],
      })
    );
    return;
  }

  // Primera vuelta: simulamos que el modelo decide llamar a preguntas_frecuentes.
  turn++;
  res.end(
    JSON.stringify({
      id: `mock-1-${turn}`,
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${turn}`,
                type: "function",
                function: { name: "preguntas_frecuentes", arguments: JSON.stringify({ tema: "ubicacion" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
  );
});

server.listen(PORT, () => console.log(`Mock OpenRouter escuchando en http://localhost:${PORT}`));
