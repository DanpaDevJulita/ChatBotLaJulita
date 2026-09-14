/**
 * PRUEBA DE PUNTA A PUNTA del flujo de pago en DOS PASOS (2026-09-11).
 *
 * Lo que tiene que quedar garantizado:
 *   1. Antes del link, al cliente se le PREGUNTA si abona el 50% o paga el total, con los dos
 *      montos exactos sacados de la base.
 *   2. El link sale con el monto YA FIJADO (Bold en modalidad CLOSE) según lo que eligió.
 *   3. Si el modelo intenta mandar el link sin que el cliente haya elegido, NO sale ningún link.
 *
 * Corre el pipeline real (runTurn + agente de ventas + herramientas reales). Lo simulado es el
 * transporte a Supabase (con la reserva ya cargada), la API de Bold (que registra exactamente
 * qué se le pidió) y el modelo, guionado para probar también el caso en que se porta mal.
 */
// Igual que en las demás pruebas: estas env vars tienen que quedar puestas ANTES de que se
// importe fakes.js (y, con él, supabase.ts) — por eso el import de acá abajo es DINÁMICO. Un
// import estático se resuelve antes que cualquier statement de este archivo, sin importar en
// qué línea esté escrito, y dejaría `supabaseConfigured` en false.
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false"; // sin Redis en esta prueba

import type { Guion } from "./fakes.js";

const { instalarSupabaseFalso, instalarModeloFalso, instalarBoldFalso, usarGuion, usarTemaOrquestador, adaptadorFalso, enviados, registroDelModelo, sembrarMensajes, sembrarReservaParaCobrar, linksPedidosABold, filasDe } = await import("./fakes.js");

instalarSupabaseFalso();
instalarModeloFalso();
instalarBoldFalso();

const { handleInbound } = await import("../src/core/pipeline/runTurn.js");

const RESERVA = 777;
const PLAN = "PLAN FAMILIAR 3 PERSONAS";
const FECHA = "2026-09-15";
const TOTAL = 760000;
const ANTICIPO = 380000; // 50% exacto del saldo

function formato(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

/**
 * [2026-09-11] El cliente no se tiene que dar cuenta de que del otro lado hay un bot. Nada de
 * menús numerados ni de "responda 1": si el mensaje trae eso, la prueba falla.
 */
function sueneAContestadorAutomatico(texto: string): string[] {
  const fallas: string[] = [];
  if (/(^|\n)\s*\*?\d\)/.test(texto)) fallas.push('el mensaje tiene un menú numerado ("1)", "2)") — suena a bot');
  if (/respond[eé]me\s+\*?\d|marca\s+\*?\d|escribe\s+\*?\d|digita/i.test(texto)) {
    fallas.push("el mensaje le pide al cliente contestar con un número — suena a contestador automático");
  }
  return fallas;
}

interface Caso {
  nombre: string;
  detalle: string;
  mensajeDelCliente: string;
  guion: Guion;
  /** Total de la reserva para este caso (por defecto TOTAL). */
  total?: number;
  /**
   * [2026-09-14] A qué bot manda el orquestador falso (ver usarTemaOrquestador en fakes.ts).
   * Por defecto "reservas" — el caso P1 (todavía preguntando cómo pagar, justo después de dar
   * los datos) cae ahí. Los que ya eligieron modalidad o dicen que pagaron son de "pagos":
   * `enviar_datos_pago` y `verificar_pago` viven en ese bot (ver src/agentes/pagos/agente.ts).
   */
  tema?: string;
  revisar: (entregado: string) => string[]; // devuelve la lista de fallas (vacía = pasó)
  /**
   * [2026-09-14] Chequeo opcional sobre `estado_conversacion` DESPUÉS del turno — para el caso
   * en que `reservas` fuerza `preguntar_forma_de_pago` (de `pagos`) en el mismo turno: si no se
   * corrigiera `last_agent`, el próximo mensaje corto del cliente ("el 50", "total") se quedaría
   * "pegado" a `reservas`, que no tiene `enviar_datos_pago` ni `verificar_pago` — ver el
   * comentario de `agenteDueno` en core/tools/types.ts y la corrección al final de runTurn.ts.
   */
  revisarEstado?: (externalId: string) => string[];
}

const CASOS: Caso[] = [
  {
    nombre: "P1. Antes del link se le pregunta cómo quiere pagar",
    detalle: "El cliente terminó de dar sus datos. Tiene que ver las DOS opciones con sus montos, y ningún link.",
    mensajeDelCliente: "listo, esos son todos los datos",
    guion: (_l, hop) => (hop === 1 ? { herramienta: "preguntar_forma_de_pago", args: { reserva_id: RESERVA } } : { texto: "(el modelo no debería llegar acá)" }),
    revisar: (t) => {
      const fallas: string[] = sueneAContestadorAutomatico(t);
      if (!t.includes(formato(ANTICIPO))) fallas.push(`falta el monto del abono (${formato(ANTICIPO)})`);
      if (!t.includes(formato(TOTAL))) fallas.push(`falta el monto total (${formato(TOTAL)})`);
      if (/https?:\/\//.test(t)) fallas.push("se mandó un link ANTES de que el cliente eligiera");
      if (linksPedidosABold.length > 0) fallas.push("se le pidió un link a Bold antes de tiempo");
      return fallas;
    },
    revisarEstado: (externalId) => {
      // Este caso lo clasifica el orquestador falso como "reservas" (el default), pero la
      // herramienta que de verdad corre es preguntar_forma_de_pago, que es de "pagos" — el
      // próximo mensaje del cliente ("el 50", "total") tiene que caer en el bot que sí sabe
      // seguir. Ver el comentario de `revisarEstado` en la interfaz `Caso`.
      const fila = filasDe("estado_conversacion").find((f: any) => f.external_id === externalId);
      const fallas: string[] = [];
      if (!fila) fallas.push("no quedó ningún estado_conversacion guardado para esta conversación");
      else if (fila.last_agent !== "pagos") {
        fallas.push(
          `last_agent quedó en "${fila.last_agent}" — debería quedar en "pagos" (preguntar_forma_de_pago es de pagos), ` +
            'si no, el próximo "el 50"/"total" del cliente se queda pegado a un bot sin herramientas para cobrarle'
        );
      }
      return fallas;
    },
  },
  {
    nombre: "P2. Elige abono del 50% -> link cerrado por ese valor",
    tema: "pagos",
    detalle: 'El cliente contesta con sus palabras ("el 50 mejor"). El link tiene que salir por $380.000, fijado.',
    mensajeDelCliente: "el 50 mejor, para ir apartando",
    guion: (_l, hop) => (hop === 1 ? { herramienta: "enviar_datos_pago", args: { reserva_id: RESERVA, modalidad: "abono" } } : { texto: "(no debería llegar acá)" }),
    revisar: (t) => {
      const fallas: string[] = sueneAContestadorAutomatico(t);
      if (!t.includes(formato(ANTICIPO))) fallas.push(`el mensaje no dice el valor del abono (${formato(ANTICIPO)})`);
      if (!/https:\/\/checkout\.bold\.co\//.test(t)) fallas.push("no se mandó el link");
      const pedido = linksPedidosABold[0]?.body;
      if (!pedido) fallas.push("no se le pidió ningún link a Bold");
      else {
        if (pedido.amount_type !== "CLOSE") fallas.push(`el link salió en modalidad ${pedido.amount_type}, no CLOSE (el cliente podría cambiar el monto)`);
        if (pedido.amount?.total_amount !== ANTICIPO) fallas.push(`Bold recibió ${pedido.amount?.total_amount} en vez de ${ANTICIPO}`);
      }
      if (t.includes(formato(TOTAL))) fallas.push("el mensaje del abono también muestra el total (confunde)");
      return fallas;
    },
  },
  {
    nombre: "P3. Elige pagar todo -> link cerrado por el total",
    tema: "pagos",
    detalle: 'El cliente dice que paga todo. El link tiene que salir por $760.000.',
    mensajeDelCliente: "no, la dejo paga completa",
    guion: (_l, hop) => (hop === 1 ? { herramienta: "enviar_datos_pago", args: { reserva_id: RESERVA, modalidad: "total" } } : { texto: "(no debería llegar acá)" }),
    revisar: (t) => {
      const fallas: string[] = sueneAContestadorAutomatico(t);
      if (!t.includes(formato(TOTAL))) fallas.push(`el mensaje no dice el valor total (${formato(TOTAL)})`);
      if (!/https:\/\/checkout\.bold\.co\//.test(t)) fallas.push("no se mandó el link");
      const pedido = linksPedidosABold[0]?.body;
      if (!pedido) fallas.push("no se le pidió ningún link a Bold");
      else {
        if (pedido.amount_type !== "CLOSE") fallas.push(`el link salió en modalidad ${pedido.amount_type}, no CLOSE`);
        if (pedido.amount?.total_amount !== TOTAL) fallas.push(`Bold recibió ${pedido.amount?.total_amount} en vez de ${TOTAL}`);
      }
      return fallas;
    },
  },
  {
    nombre: "P4. El modelo intenta mandar el link SIN que el cliente eligiera",
    tema: "pagos",
    detalle: "Llama enviar_datos_pago sin modalidad. No puede salir ningún link: se le vuelve a preguntar.",
    mensajeDelCliente: "quiero pagar",
    guion: (_l, hop) => (hop === 1 ? { herramienta: "enviar_datos_pago", args: { reserva_id: RESERVA } } : { texto: "(no debería llegar acá)" }),
    revisar: (t) => {
      const fallas: string[] = sueneAContestadorAutomatico(t);
      if (/https?:\/\//.test(t)) fallas.push("SE MANDÓ UN LINK sin que el cliente eligiera el monto");
      if (linksPedidosABold.length > 0) fallas.push("se le pidió un link a Bold sin elección del cliente");
      if (!t.includes(formato(ANTICIPO)) || !t.includes(formato(TOTAL))) fallas.push("no se le volvió a preguntar con los dos montos");
      return fallas;
    },
  },
  {
    nombre: "P5. El modelo inventa una modalidad que no existe",
    tema: "pagos",
    detalle: 'Llama con modalidad="mitad". Tampoco puede salir un link a ciegas.',
    mensajeDelCliente: "dale",
    guion: (_l, hop) => (hop === 1 ? { herramienta: "enviar_datos_pago", args: { reserva_id: RESERVA, modalidad: "mitad" } } : { texto: "(no debería llegar acá)" }),
    revisar: (t) => {
      const fallas: string[] = sueneAContestadorAutomatico(t);
      if (/https?:\/\//.test(t)) fallas.push("SE MANDÓ UN LINK con una modalidad inventada");
      if (linksPedidosABold.length > 0) fallas.push("se le pidió un link a Bold con una modalidad inventada");
      return fallas;
    },
  },
  {
    nombre: "P6. El abono es el 50% EXACTO, nunca un peso de más",
    tema: "pagos",
    detalle:
      "Con un plan de $569.000 el 50% son $284.500. El redondeo a miles que había antes cobraba " +
      "$285.000 — $500 de más, en contra del cliente y sin que él lo pidiera.",
    mensajeDelCliente: "abono el 50",
    total: 569000,
    guion: (_l, hop) => (hop === 1 ? { herramienta: "enviar_datos_pago", args: { reserva_id: RESERVA, modalidad: "abono" } } : { texto: "(no debería llegar acá)" }),
    revisar: (t) => {
      const fallas: string[] = sueneAContestadorAutomatico(t);
      const esperado = 284500;
      const pedido = linksPedidosABold[0]?.body;
      if (!pedido) fallas.push("no se le pidió ningún link a Bold");
      else if (pedido.amount?.total_amount !== esperado) {
        fallas.push(`Bold recibió ${pedido.amount?.total_amount} en vez del 50% exacto (${esperado})`);
      }
      if (!t.includes(formato(esperado))) fallas.push(`el mensaje no dice ${formato(esperado)}`);
      return fallas;
    },
  },
];

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA DE PUNTA A PUNTA — pago en dos pasos (preguntar, después cobrar)");
  console.log("█".repeat(92));
  console.log(`  Reserva #${RESERVA} · ${PLAN} · ${FECHA}`);
  console.log(`  Total en la base: ${formato(TOTAL)}   ·   Abono del 50%: ${formato(ANTICIPO)}`);

  let fallos = 0;

  for (const [i, caso] of CASOS.entries()) {
    const externalId = `+5730000000${i}`;
    sembrarMensajes([]);
    sembrarReservaParaCobrar({ reservaId: RESERVA, plan: PLAN, fecha: FECHA, total: caso.total ?? TOTAL, acompanantes: ["Marcela Gómez", "Efraín Ruiz"] });
    enviados.length = 0;
    usarGuion(caso.guion);
    usarTemaOrquestador(caso.tema ?? "reservas");

    console.log("\n" + "─".repeat(92));
    console.log(`CASO ${caso.nombre}`);
    console.log(`  ${caso.detalle}`);
    console.log(`  El cliente escribe: "${caso.mensajeDelCliente}"`);
    console.log("─".repeat(92));

    try {
      await Promise.race([
        handleInbound({ channel: "whatsapp", externalId, text: caso.mensajeDelCliente, timestamp: new Date().toISOString() }, adaptadorFalso as any),
        new Promise((r) => setTimeout(r, 25000)),
      ]);
    } catch (e) {
      console.log(`  (excepción al final del turno, se evalúa lo enviado): ${(e as Error).message}`);
    }

    console.log("\n  Lo que hizo el modelo:");
    for (const l of registroDelModelo) console.log(`    · ${l}`);

    const entregado = enviados[enviados.length - 1] ?? "(NO SE ENVIÓ NADA)";
    console.log("\n  ── MENSAJE QUE LE LLEGA AL CLIENTE ──");
    console.log(entregado.split("\n").map((l) => "  | " + l).join("\n"));

    if (linksPedidosABold.length > 0) {
      const b = linksPedidosABold[0].body;
      console.log(`\n  Lo que se le pidió a Bold: amount_type=${b.amount_type} · monto=${b.amount?.total_amount ?? "(lo pone el cliente)"} · ref=${b.reference}`);
    } else {
      console.log("\n  No se le pidió ningún link a Bold en este turno.");
    }

    const fallas = caso.revisar(entregado);
    if (caso.revisarEstado) fallas.push(...caso.revisarEstado(externalId));
    if (fallas.length > 0) {
      for (const f of fallas) console.log(`  ❌ ${f}`);
      fallos++;
    } else {
      console.log("  ✅ el caso pasó");
    }
  }

  console.log("\n" + "█".repeat(92));
  if (fallos === 0) console.log(`  RESULTADO: ✅ ${CASOS.length}/${CASOS.length} casos pasaron.`);
  else { console.log(`  RESULTADO: ❌ ${fallos} de ${CASOS.length} casos fallaron.`); process.exitCode = 1; }
  console.log("█".repeat(92) + "\n");
}

main().catch((e) => { console.error("Error corriendo la prueba:", e); process.exitCode = 1; });
