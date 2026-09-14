/**
 * PRUEBA: el orquestador decide con el estado real de la conversación, no con un mensaje suelto.
 *
 * [2026-09-14] Daniel: "se supone que tengo un bot orquestador, él debería estar monitoreando
 * todas las conversaciones y dependiendo lo que el cliente escriba mandarlo al bot que se encarga
 * de eso sin que el cliente se entere".
 *
 * Existía y enrutaba en silencio, sí — pero decidía casi a ciegas: el código solo le mandaba el
 * último mensaje y `last_agent`, aunque su propio prompt decía que recibía además un resumen y el
 * estado de la reserva en curso. Por eso un "abono" suelto era indistinguible de cualquier otra
 * cosa, la "Pegajosidad" cargaba sola con todo el peso, y hubo que sumar `agenteDueno` (ver
 * core/tools/types.ts) para corregir por fuera lo que el router no tenía forma de acertar.
 *
 * Esta prueba no juzga al modelo (eso depende del LLM): mira EXACTAMENTE lo que el pipeline le
 * pone enfrente, que es lo que estaba roto. Se intercepta la llamada al modelo y se lee el bloque
 * de estado que le llega al orquestador.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.LOBBYPMS_API_TOKEN ||= "";

const { instalarSupabaseFalso, instalarModeloFalso, usarGuion, adaptadorFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();
instalarModeloFalso();

const { openrouter } = await import("../src/core/llm/openrouter.js");
const { handleInbound } = await import("../src/core/pipeline/runTurn.js");

/**
 * Lo que vio el orquestador en cada turno. Se reconoce su llamada porque es la única que va con
 * la herramienta `enrutar`; el bloque de estado es el segundo mensaje de sistema.
 */
const loQueVioElOrquestador: string[] = [];
const crearOriginal = openrouter.chat.completions.create.bind(openrouter.chat.completions);
(openrouter.chat.completions as any).create = async (params: any) => {
  const esElRouter = JSON.stringify(params?.tools ?? []).includes("enrutar");
  if (esElRouter) {
    const bloques = (params.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => m.content);
    loQueVioElOrquestador.push(bloques[bloques.length - 1] ?? "");
  }
  return crearOriginal(params);
};

const CANAL = "whatsapp";
let fallas = 0;

function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

async function mensaje(externalId: string, texto: string) {
  usarGuion(() => ({ texto: "Listo 💚" }));
  await handleInbound(
    { channel: CANAL, externalId, text: texto, timestamp: new Date().toISOString() },
    adaptadorFalso
  );
}

console.log("CASO 1. Sin reserva todavía: se lo dice explícitamente\n");
{
  loQueVioElOrquestador.length = 0;
  await mensaje("+573001110001", "hola, info del glamping");

  const visto = loQueVioElOrquestador.at(-1) ?? "";
  console.log(visto.split("\n").map((l) => `  | ${l}`).join("\n"));

  revisar(visto.includes("Estado de la conversación"), "recibe un bloque de estado", "no recibe ningún estado");
  revisar(/NO tiene ninguna reserva registrada/i.test(visto), "sabe que no hay reserva todavía", "no le dice nada de la reserva");
}

console.log("\nCASO 2. Con reserva registrada: el dato que cambia todo\n");
{
  const cliente = "+573001110002";
  filasDe("estado_conversacion").push({
    canal: CANAL,
    external_id: cliente,
    last_agent: "reservas",
    reserva_activa_id: 77,
    reserva_activa_en: new Date().toISOString(),
    escalado_en: null,
  });

  loQueVioElOrquestador.length = 0;
  await mensaje(cliente, "abono");

  const visto = loQueVioElOrquestador.at(-1) ?? "";
  console.log(visto.split("\n").map((l) => `  | ${l}`).join("\n"));

  revisar(visto.includes("#77"), "sabe que esta conversación ya tiene la reserva #77", "no le llegó la reserva activa");
  revisar(visto.includes("last_agent=reservas"), "sabe qué bot atendió antes", "no le llegó el last_agent");
}

console.log("\nCASO 3. Ve los mensajes anteriores (un \"4\" solo no dice nada; con contexto, sí)\n");
{
  const cliente = "+573001110003";
  loQueVioElOrquestador.length = 0;

  await mensaje(cliente, "quiero reservar para el 20");
  await mensaje(cliente, "4");

  const visto = loQueVioElOrquestador.at(-1) ?? "";
  console.log(visto.split("\n").slice(-4).map((l) => `  | ${l}`).join("\n"));

  revisar(visto.includes("quiero reservar para el 20"), "ve el mensaje anterior del cliente", "no ve el historial");
  revisar(
    (visto.match(/Cliente: 4\b/g) ?? []).length === 0,
    "el mensaje nuevo no viene duplicado dentro del historial",
    "el mensaje nuevo aparece repetido en el historial"
  );
}

console.log("\nCASO 4. Conversación escalada: se lo dice, para que no le robe el turno al equipo\n");
{
  const cliente = "+573001110004";
  filasDe("estado_conversacion").push({
    canal: CANAL,
    external_id: cliente,
    last_agent: "humano",
    reserva_activa_id: null,
    reserva_activa_en: null,
    escalado_en: new Date().toISOString(),
  });

  loQueVioElOrquestador.length = 0;
  await mensaje(cliente, "sigo esperando");

  const visto = loQueVioElOrquestador.at(-1) ?? "";
  revisar(/ESCALADA/i.test(visto), "sabe que está escalada", "no se entera de que está escalada");
}

console.log("\nCASO 5. Retoma después de mucho tiempo: no aplica Pegajosidad, reevalúa\n");
{
  const cliente = "+573001110005";
  filasDe("estado_conversacion").push({
    canal: CANAL,
    external_id: cliente,
    last_agent: "pagos",
    reserva_activa_id: 88,
    reserva_activa_en: new Date().toISOString(),
    escalado_en: null,
  });

  loQueVioElOrquestador.length = 0;

  // Simula que el último mensaje fue hace 2 horas
  const ahoraHace2Horas = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const ahora = new Date().toISOString();

  // Llamada al orquestador con timestamps que indican 2 horas de diferencia
  const decision = await (await import("../src/agentes/orquestador/route.js")).enrutarMensaje({
    mensaje: "Hola",
    lastAgent: "pagos",
    reservaActivaId: 88,
    escalado: false,
    ultimosMensajes: [
      { role: "user", content: "Ya pagué" },
      { role: "assistant", content: "Pasaron 10 minutos y no me apareció el pago..." }
    ],
    ultimoMensajeClienteEn: ahoraHace2Horas,
    ahoraEn: ahora,
  });

  revisar(decision.agente !== "pagos", "después de 2 horas no aplica Pegajosidad", "seguía en pagos por pegajosidad");
  revisar(
    decision.agente === "postventa" || decision.agente === "informacion" || decision.agente === "reservas",
    "reevalúa y va a otro agente (no sigue en pagos)",
    `fue a ${decision.agente}`
  );
}

console.log(
  "\nCASO 6. Bucle de escalamiento resuelto: el eco de 'ya te comunico con el equipo' no vuelve a escalar\n"
);
{
  // [2026-09-14] Reproduce EXACTAMENTE lo que reportó Daniel: el cliente escala por un pago no
  // registrado, el equipo manda /resuelto (limpia escalado_en y last_agent), y el cliente
  // saluda de nuevo. El bug real: el propio MENSAJE_ESCALADO ("Ya te comunico con el equipo...")
  // quedaba guardado en el historial como mensaje del bot, y el orquestador lo leía como si la
  // conversación siguiera escalada — aunque `escalado_en` ya estuviera en null — y volvía a
  // mandar a `humano`. Este caso verifica que ese eco YA NO se le pasa al orquestador.
  const cliente = "+573001110006";
  const { MENSAJE_ESCALADO } = await import("../src/core/pipeline/runTurn.js");

  filasDe("estado_conversacion").push({
    canal: CANAL,
    external_id: cliente,
    last_agent: null, // /resuelto ya lo reseteó
    reserva_activa_id: null,
    reserva_activa_en: null,
    escalado_en: null, // /resuelto ya lo limpió
  });
  filasDe("mensajes").push(
    { canal: CANAL, external_id: cliente, role: "user", content: "ya pagué y no me aparece", created_at: new Date(Date.now() - 60_000).toISOString() },
    { canal: CANAL, external_id: cliente, role: "assistant", content: MENSAJE_ESCALADO, created_at: new Date(Date.now() - 30_000).toISOString() }
  );

  loQueVioElOrquestador.length = 0;
  await mensaje(cliente, "Hola");

  const visto = loQueVioElOrquestador.at(-1) ?? "";
  console.log(visto.split("\n").map((l) => `  | ${l}`).join("\n"));

  revisar(
    !visto.includes("Ya te comunico con el equipo"),
    "el orquestador ya NO ve el eco del aviso de escalamiento en el historial",
    "el eco del aviso de escalamiento sigue llegándole al orquestador"
  );
  revisar(!/ESCALADA/i.test(visto), "no le dice que está escalada (ya se resolvió)", "le sigue diciendo que está escalada");
}

console.log("\nCASO 7. Regla dura: aunque el MODELO diga `humano`, un saludo suelto en conversación NO escalada no escala\n");
{
  // [2026-09-14] El CASO 6 verifica lo que el orquestador VE; este verifica lo que sale aunque el
  // modelo real se equivoque igual. Se fuerza al modelo falso a devolver `humano` para "Hola" y
  // se comprueba que el pipeline NO escala (ni aviso al cliente, ni marca escalado_en).
  const { enrutarSiempreA, enviados } = await import("./fakes.js");
  const { enrutarMensaje, esSaludoSuelto } = await import("../src/agentes/orquestador/route.js");

  // 7a. Directo sobre el router
  enrutarSiempreA("humano");
  const sinReserva = await enrutarMensaje({ mensaje: "Hola!", lastAgent: null, reservaActivaId: null, escalado: false });
  const conReserva = await enrutarMensaje({ mensaje: "buenas 👋", lastAgent: null, reservaActivaId: 91, escalado: false });
  const escalada = await enrutarMensaje({ mensaje: "hola", lastAgent: "humano", reservaActivaId: null, escalado: true });
  const reclamo = await enrutarMensaje({ mensaje: "hola, sigo sin que me confirmen el pago", lastAgent: null, reservaActivaId: 91, escalado: false });
  revisar(sinReserva.agente === "informacion", "saludo sin reserva → informacion (no humano)", `fue a ${sinReserva.agente}`);
  revisar(conReserva.agente === "postventa", "saludo con reserva → postventa (no humano)", `fue a ${conReserva.agente}`);
  revisar(escalada.agente === "humano", "si SÍ está escalada, el saludo sigue en humano (la regla no se mete)", `fue a ${escalada.agente}`);
  revisar(reclamo.agente === "humano", "un reclamo real con 'hola' adelante NO es saludo suelto: sigue a humano", `fue a ${reclamo.agente}`);
  revisar(
    ["Hola", "HOLA", "holaaa", "Buenas", "buenos días", "Buenas tardes!", "hey", "hi", "Hola 🙂", "qué más", "¡Hola!"].every(esSaludoSuelto) &&
      !["hola necesito ayuda", "ya pagué", "hola?? nadie responde", "4"].some(esSaludoSuelto),
    "esSaludoSuelto reconoce saludos y rechaza mensajes con contenido",
    "esSaludoSuelto clasifica mal algún caso"
  );

  // 7b. Por todo el pipeline: el escenario exacto de Daniel, con el modelo insistiendo en humano
  const cliente = "+573001110007";
  const { MENSAJE_ESCALADO } = await import("../src/core/pipeline/runTurn.js");
  filasDe("estado_conversacion").push({
    canal: CANAL, external_id: cliente, last_agent: null, reserva_activa_id: null, reserva_activa_en: null, escalado_en: null,
  });
  filasDe("mensajes").push(
    { canal: CANAL, external_id: cliente, role: "user", content: "ya pagué y no me aparece", created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() },
    { canal: CANAL, external_id: cliente, role: "assistant", content: MENSAJE_ESCALADO, created_at: new Date(Date.now() - 3 * 60 * 60_000 + 5_000).toISOString() }
  );
  const enviadosAntes = enviados.length;
  await mensaje(cliente, "Hola");
  const enviadosAhora = enviados.slice(enviadosAntes);
  const fila = filasDe("estado_conversacion").find((f: any) => f.external_id === cliente);
  revisar(!enviadosAhora.some((t: string) => t.includes("Ya te comunico con el equipo")), "al cliente NO le llega el aviso de escalamiento", `le llegó: ${enviadosAhora.join(" | ")}`);
  revisar(!fila?.escalado_en, "la conversación NO queda marcada como escalada", `escalado_en=${fila?.escalado_en}`);
  revisar(fila?.last_agent === "informacion", "last_agent queda en informacion", `last_agent=${fila?.last_agent}`);
  enrutarSiempreA("reservas");
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El orquestador ya decide con el estado real de la conversación, no a ciegas.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
