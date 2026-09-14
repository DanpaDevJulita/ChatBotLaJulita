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

/**
 * [2026-09-14] Lo que el orquestador necesita para decidir bien.
 *
 * Antes recibía DOS cosas: el último mensaje suelto y `last_agent`. Su propio prompt decía que
 * recibía cuatro (mensaje, last_agent, un resumen y el estado de la reserva en curso) — o sea,
 * le pedíamos que enrutara con un contexto que nunca le llegaba. Daniel lo dijo con todas las
 * letras: "se supone que tengo un bot orquestador, él debería estar monitoreando todas las
 * conversaciones y dependiendo lo que el cliente escriba mandarlo al bot que se encarga de eso".
 * No estaba monitoreando nada: miraba un mensaje aislado.
 *
 * Eso explicaba lo frágil que era todo alrededor: la "Pegajosidad" cargaba sola con el peso, y
 * hubo que agregar `agenteDueno` (ver core/tools/types.ts) para corregir por fuera el ruteo que
 * el orquestador no tenía forma de acertar. Un "abono" suelto, sin saber si hay una reserva
 * registrada esperando pago, es indistinguible de cualquier otra cosa.
 *
 * Lo que se le suma ahora NO cuesta ninguna consulta extra: `estado` ya se lee en runTurn.ts
 * antes de enrutar, y el historial ya está en memoria. Es contexto gratis que estábamos tirando.
 */
export interface ContextoRuteo {
  mensaje: string;
  lastAgent: string | null;
  /** La reserva que ESTA conversación registró, si hay alguna viva (conversacionActivaRepo). */
  reservaActivaId?: number | null;
  /** true si la conversación está esperando a una persona del equipo. */
  escalado?: boolean;
  /** Los últimos mensajes de la charla (viejo → nuevo), sin los internos de herramientas. */
  ultimosMensajes?: { role: string; content: string }[];
  /** ISO8601 del último mensaje cliente en esta conversación, para detectar si pasó mucho tiempo. */
  ultimoMensajeClienteEn?: string;
  /** ISO8601 del mensaje actual que se está enrutando. */
  ahoraEn?: string;
}

/** Cuántos mensajes previos se le muestran al router, y cuánto de cada uno. */
const MENSAJES_DE_CONTEXTO = 6;
const LARGO_MAXIMO_POR_MENSAJE = 220;

function armarEstadoTexto(params: ContextoRuteo): string {
  const lineas: string[] = [];

  lineas.push(
    params.lastAgent
      ? `last_agent=${params.lastAgent} (qué bot atendió el mensaje anterior).`
      : "Primer mensaje de esta conversación: no hay last_agent."
  );

  // Calcula cuánto tiempo pasó desde el último mensaje para detectar "retomas" de conversación.
  // Si pasó mucho tiempo (> 30 min) y el cliente reabre con un saludo genérico, probablemente
  // NO sea "Pegajosidad" — es una nueva fase de la conversación, hay que reevaluar el agente.
  if (params.ultimoMensajeClienteEn && params.ahoraEn) {
    try {
      const ahora = new Date(params.ahoraEn).getTime();
      const ultimoMensaje = new Date(params.ultimoMensajeClienteEn).getTime();
      const minutosTranscurridos = Math.round((ahora - ultimoMensaje) / 1000 / 60);
      if (minutosTranscurridos > 0) {
        lineas.push(`${minutosTranscurridos} minuto(s) desde el último mensaje de esta conversación.`);
      }
    } catch (e) {
      // timestamps inválidos, ignorar
    }
  }

  // Lo más decisivo: si ya hay una reserva registrada, un "abono"/"sí"/"ya pagué" casi siempre
  // es del hilo de pago, no una pregunta nueva.
  lineas.push(
    params.reservaActivaId
      ? `Esta conversación YA tiene una reserva registrada (#${params.reservaActivaId}), así que lo ` +
        "que siga probablemente sea del hilo de pago o de postventa, no una consulta desde cero."
      : "Esta conversación todavía NO tiene ninguna reserva registrada."
  );

  if (params.escalado) {
    lineas.push("La conversación está ESCALADA: el cliente está esperando a una persona del equipo.");
  }

  const previos = (params.ultimosMensajes ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MENSAJES_DE_CONTEXTO);

  if (previos.length > 0) {
    const transcripcion = previos
      .map((m) => {
        const quien = m.role === "user" ? "Cliente" : "Bot";
        const texto = m.content.replace(/\s+/g, " ").trim();
        return `${quien}: ${texto.length > LARGO_MAXIMO_POR_MENSAJE ? `${texto.slice(0, LARGO_MAXIMO_POR_MENSAJE)}…` : texto}`;
      })
      .join("\n");
    lineas.push(`Últimos mensajes de la conversación (el más nuevo al final):\n${transcripcion}`);
  }

  return `Estado de la conversación:\n${lineas.join("\n")}`;
}

/**
 * [2026-09-14] Un saludo suelto: "hola", "buenas", "buenos días", "hey", "hi", etc. — con o sin
 * signos y emojis, pero SIN nada más. Si el cliente escribe "hola, sigo sin que me confirmen el
 * pago" ya no es un saludo suelto y esta regla no aplica.
 */
const SALUDO_SUELTO =
  /^[\s¡!¿?.,\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]*(hola+|holi+s?|hell?o+|hi+|hey+|buenas+|buen(os|as)?\s+(d[ií]as?|tardes|noches)|buen\s+d[ií]a|qu[eé]\s+m[aá]s|saludos|qu[eé]\s+tal)[\s¡!¿?.,\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]*$/iu;

export function esSaludoSuelto(texto: string): boolean {
  return SALUDO_SUELTO.test((texto ?? "").trim());
}

/**
 * [2026-09-14] Regla DURA, fuera del modelo: si la conversación NO está escalada y el cliente
 * solo saluda, el orquestador no puede devolver `humano`. Punto.
 *
 * Por qué existe: Daniel reportó el bucle "escalar por pago → /resuelto → cliente escribe
 * 'Hola' → vuelve a soporte". Se atacó primero filtrando del historial el aviso fijo del bot
 * ("Ya te comunico con el equipo...") y reforzando el prompt — pero el modelo igual sigue viendo
 * el reclamo original del cliente en el historial, y el prompt le dice que las disputas de pago
 * van a `humano`. Dejar eso a que el LLM "entienda" el matiz es apostar; esta regla no apuesta:
 * un saludo suelto nunca reitera un reclamo, así que si el modelo dijo `humano`, se corrige acá
 * al agente que corresponde por estado (reserva registrada → postventa, si no → informacion).
 *
 * No toca el caso escalado=true: ahí `humano` sigue siendo la respuesta correcta siempre.
 */
function corregirSaludoEscalado(params: ContextoRuteo, decision: DecisionRuteo): DecisionRuteo {
  if (decision.agente !== "humano" || params.escalado || !esSaludoSuelto(params.mensaje)) return decision;
  const agente: NombreAgente = params.reservaActivaId ? "postventa" : "informacion";
  console.warn(
    `[orquestador] el modelo quiso escalar un saludo suelto ("${params.mensaje.trim()}") en una conversación ` +
      `NO escalada (motivo del modelo: "${decision.motivo}") — se corrige a ${agente}.`
  );
  return { agente, motivo: `saludo suelto en conversación no escalada: nunca escala (modelo dijo humano: ${decision.motivo})` };
}

export async function enrutarMensaje(params: ContextoRuteo): Promise<DecisionRuteo> {
  return corregirSaludoEscalado(params, await enrutarConModelo(params));
}

async function enrutarConModelo(params: ContextoRuteo): Promise<DecisionRuteo> {
  const estadoTexto = armarEstadoTexto(params);

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
