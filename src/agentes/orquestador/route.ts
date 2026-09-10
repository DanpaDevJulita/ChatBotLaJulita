import fs from "node:fs";
import path from "node:path";
import { openrouter, ORCHESTRATOR_MODEL } from "../../core/llm/openrouter.js";

const ORQUESTADOR_PROMPT = fs.readFileSync(path.join(process.cwd(), "src", "agentes", "orquestador", "prompt.md"), "utf-8");

export type NombreAgente = "informacion" | "reservas" | "pagos" | "postventa" | "humano";

const AGENTES_VALIDOS: NombreAgente[] = ["informacion", "reservas", "pagos", "postventa", "humano"];

export interface DecisionRuteo {
  agente: NombreAgente;
  motivo: string;
}

const ENRUTAR_TOOL = {
  type: "function" as const,
  function: {
    name: "enrutar",
    description: "Decide a qué agente se le pasa el mensaje del cliente.",
    parameters: {
      type: "object",
      properties: {
        agente: {
          type: "string",
          enum: AGENTES_VALIDOS,
          description: "El agente que debe atender este mensaje.",
        },
        motivo: {
          type: "string",
          description: "Motivo corto (uso interno, el cliente nunca lo ve).",
        },
      },
      required: ["agente", "motivo"],
    },
  },
};

/**
 * El orquestador nunca le habla al cliente — solo decide a qué agente pasarle el turno.
 * Llama al modelo con la herramienta `enrutar` forzada (tool_choice), así el resultado
 * siempre es una decisión estructurada, nunca texto libre.
 *
 * Si el modelo no llama la herramienta, devuelve un agente inválido, o la llamada falla
 * (timeout, error de red, etc.), caemos a "informacion" — es el único agente con
 * herramientas reales hoy, así que es el fallback más seguro para no romper la
 * conversación del cliente por un fallo del router.
 */
// Notas de diseño del router (antes estaban DENTRO de src/agentes/orquestador/prompt.md, lo que se lo
// mandaba al modelo en cada turno diciéndole — ya desactualizado — que este router "todavía
// no existe"; se movieron acá el 2026-09-08):
//   - La herramienta `enrutar` de salida forzada (tool_choice) ya está implementada: es
//     ENRUTAR_TOOL, acá arriba.
//   - `last_agent` ya se persiste por conversación en la tabla `estado_conversacion`
//     (src/core/db/estadoRepo.ts) — de ahí sale la pegajosidad.
//   - El `resumen` de conversación sigue pendiente (columna reservada en el schema, aún sin
//     summarizer que la llene).
//   - El modelo de este router conviene barato/rápido: se configura con ORCHESTRATOR_MODEL
//     en el .env; si está vacío usa el mismo modelo de los agentes.
export async function enrutarMensaje(params: { mensaje: string; lastAgent: string | null }): Promise<DecisionRuteo> {
  const estadoTexto = params.lastAgent
    ? `Estado previo: last_agent=${params.lastAgent}.`
    : "Estado previo: primer mensaje de esta conversación, no hay last_agent.";

  try {
    const completion = await openrouter.chat.completions.create({
      model: ORCHESTRATOR_MODEL,
      messages: [
        { role: "system", content: ORQUESTADOR_PROMPT },
        { role: "system", content: estadoTexto },
        { role: "user", content: params.mensaje },
      ],
      tools: [ENRUTAR_TOOL],
      tool_choice: { type: "function", function: { name: "enrutar" } },
      // [2026-09-08] Temperatura 0: el router no tiene que ser creativo, tiene que ser
      // REPETIBLE. Sin esto, el mismo mensaje podía caer en agentes distintos entre turnos
      // (y con la pegajosidad eso se arrastra a los turnos siguientes).
      temperature: 0,
    });

    const call = completion.choices[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("El orquestador no llamó a enrutar");

    const args = JSON.parse(call.function.arguments || "{}");
    const agente: NombreAgente = AGENTES_VALIDOS.includes(args.agente) ? args.agente : "informacion";
    return { agente, motivo: typeof args.motivo === "string" ? args.motivo : "" };
  } catch (err) {
    console.error("[orquestador] Falló el enrutamiento, uso 'informacion' por default:", err);
    return { agente: "informacion", motivo: "fallback por error del orquestador" };
  }
}
