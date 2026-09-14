/**
 * PRUEBA: "ya pagué" — el bot le pregunta al banco en vez de pedir el comprobante.
 *
 * Es el respaldo del webhook: si Bold no alcanzó a avisarnos (su doc admite hasta 10 minutos de
 * demora, y si las llaves de integración no están habilitadas no avisa nunca), el cliente ya pagó
 * y está esperando. Con `verificar_pago` el bot consulta el estado del link contra Bold y, si
 * entró, lo registra por el MISMO camino idempotente que usa el webhook.
 *
 * Lo que se prueba acá es, sobre todo, que NO se confirme de más: un "sí, ya lo vi" falso le
 * cuesta un cupo al negocio.
 */
// Igual que en las demás pruebas: import DINÁMICO de fakes.js, para que estas env vars queden
// puestas ANTES de que supabase.ts las lea (un import estático se resuelve antes que cualquier
// statement de este archivo, sin importar la línea en la que esté escrito).
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false"; // sin Redis en esta prueba

import type { Guion } from "./fakes.js";

const {
  instalarSupabaseFalso, instalarModeloFalso, instalarBoldFalso, boldResponderaEstado,
  usarGuion, usarTemaOrquestador, adaptadorFalso, enviados, registroDelModelo, sembrarMensajes, filasDe,
  rpcsLlamados, consultasABold,
} = await import("./fakes.js");

instalarSupabaseFalso();
instalarModeloFalso();
instalarBoldFalso();

const { handleInbound } = await import("../src/core/pipeline/runTurn.js");

const RESERVA = 88;
const PLAN = "PLAN FAMILIAR 3 PERSONAS";
const TOTAL = 760000;
const ABONO = 380000;
const REF = `res${RESERVA}-abono-1789000000000`;

function formato(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

/** Deja la base como queda después de mandarle el link: un pago pendiente, con su link. */
function sembrar(opts: { pagado?: number } = {}) {
  const pagado = opts.pagado ?? 0;
  const r = filasDe("reservas"); r.length = 0;
  r.push({ id: RESERVA, cliente_id: 1, fecha_reservada: "2026-09-15", numero_huespedes: 3, planes: { nombre: PLAN } });

  const c = filasDe("clientes"); c.length = 0;
  c.push({ id: 1, nombre: "Daniel Pataquiva", celular: "3212191805" });

  const v = filasDe("v_estado_cuenta"); v.length = 0;
  v.push({
    reserva_id: RESERVA, cliente_id: 1, cliente: "Daniel Pataquiva", celular: "3212191805",
    fecha_checkin: "2026-09-15", total: TOTAL, pagado, saldo: TOTAL - pagado,
    estado_pago: pagado > 0 ? "con_anticipo" : "pendiente", estado_reserva: "borrador", num_pagos: pagado > 0 ? 1 : 0,
  });

  const p = filasDe("pagos"); p.length = 0;
  if (pagado === 0) {
    p.push({ id: 1, reserva_id: RESERVA, tipo: "abono", valor: ABONO, referencia: REF, estado: "pendiente",
             payment_link: "LNK_PRUEBA", link_url: "https://checkout.bold.co/payment/LNK_PRUEBA" });
  }

  filasDe("mensajes").length = 0;
  enviados.length = 0;
  rpcsLlamados.length = 0;
  consultasABold.length = 0;
}

/** El guion: el modelo llama verificar_pago, que es lo que debe hacer ante un "ya pagué". */
const GUION_VERIFICA: Guion = (_l, hop) =>
  hop === 1 ? { herramienta: "verificar_pago", args: { reserva_id: RESERVA } } : { texto: "(no debería llegar acá)" };

interface Caso { nombre: string; detalle: string; preparar: () => void; revisar: (t: string) => string[] }

const CASOS: Caso[] = [
  {
    nombre: "V1. Bold dice PAID: se confirma y se registra, sin pedir comprobante",
    detalle: "El caso feliz: el cliente pagó, el webhook no llegó, y el bot lo verifica solo.",
    preparar: () => { sembrar(); boldResponderaEstado({ status: "PAID", transaction_id: "TX-123", total: ABONO, reference: REF }); },
    revisar: (t) => {
      const fallas: string[] = [];
      if (consultasABold.length === 0) fallas.push("no le preguntó nada a Bold");
      if (!/verific/i.test(t)) fallas.push("no le dice al cliente que lo verificó");
      if (!t.includes(formato(ABONO))) fallas.push(`no dice el monto que entró (${formato(ABONO)})`);
      if (/comprobante/i.test(t) && !/no necesitas/i.test(t)) fallas.push("le pide el comprobante igual");
      const registro = rpcsLlamados.find((r) => r.nombre === "fn_registrar_pago_aprobado");
      if (!registro) fallas.push("no registró el pago en la base");
      else if (registro.args?.p_referencia !== REF) fallas.push(`registró la referencia equivocada (${registro.args?.p_referencia})`);
      return fallas;
    },
  },
  {
    nombre: "V2. El link sigue ACTIVE: NO se confirma nada",
    detalle: "Lo más importante: no dar por pagado lo que no está pagado.",
    preparar: () => { sembrar(); boldResponderaEstado({ status: "ACTIVE" }); },
    revisar: (t) => {
      const fallas: string[] = [];
      if (rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("REGISTRÓ UN PAGO que Bold no confirmó");
      if (/confirmad|ya nos entró|queda confirmada/i.test(t)) fallas.push("le dijo al cliente que el pago entró cuando no entró");
      if (!/todavía no/i.test(t)) fallas.push("no le dice claramente que aún no aparece");
      return fallas;
    },
  },
  {
    nombre: "V3. Bold no responde: tampoco se confirma, y se lo dice",
    detalle: "Un fallo de consulta NO puede interpretarse como pago recibido.",
    preparar: () => { sembrar(); boldResponderaEstado(null); },
    revisar: (t) => {
      const fallas: string[] = [];
      if (rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("REGISTRÓ UN PAGO sin poder consultarlo");
      if (/confirmad|ya nos entró/i.test(t)) fallas.push("le dijo al cliente que el pago entró sin poder verificarlo");
      if (!/no pude confirmarlo/i.test(t)) fallas.push("no le avisa que no pudo verificar");
      return fallas;
    },
  },
  {
    nombre: "V4. Bold dice REJECTED: no se confirma",
    detalle: "Un pago rechazado no es un pago.",
    preparar: () => { sembrar(); boldResponderaEstado({ status: "REJECTED" }); },
    revisar: (t) => {
      const fallas: string[] = [];
      if (rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("REGISTRÓ un pago RECHAZADO");
      if (/confirmad|ya nos entró/i.test(t)) fallas.push("le dijo que el pago entró estando rechazado");
      return fallas;
    },
  },
  {
    nombre: "V5. Ya estaba pagada (el webhook llegó antes): se lo confirma sin volver a cobrar",
    detalle: "Los dos caminos conviven: si el webhook ya la registró, verificar no puede romper nada.",
    preparar: () => { sembrar({ pagado: TOTAL }); boldResponderaEstado({ status: "PAID" }); },
    revisar: (t) => {
      const fallas: string[] = [];
      if (!/ya está|pagada/i.test(t)) fallas.push("no le confirma que ya está pagada");
      if (!t.includes(formato(TOTAL))) fallas.push("no dice el monto pagado");
      if (rpcsLlamados.some((r) => r.nombre === "fn_crear_pago_pendiente")) fallas.push("generó un cobro nuevo sobre una reserva ya pagada");
      return fallas;
    },
  },
];

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log('  PRUEBA — "ya pagué": el bot le pregunta al banco, no pide comprobante');
  console.log("█".repeat(92));

  let fallos = 0;
  for (const [i, caso] of CASOS.entries()) {
    const externalId = `+5731000000${i}`;
    caso.preparar();
    sembrarMensajes([]);
    usarGuion(GUION_VERIFICA);
    // [2026-09-14] "ya hice el pago" es tema de PAGOS (verificar_pago vive en ese bot desde que
    // se separó de ventas — ver src/agentes/pagos/agente.ts). Sin esto, el orquestador falso
    // (default "reservas") manda al bot que no tiene la herramienta.
    usarTemaOrquestador("pagos");

    console.log("\n" + "─".repeat(92));
    console.log(`CASO ${caso.nombre}`);
    console.log(`  ${caso.detalle}`);
    console.log("─".repeat(92));

    try {
      await Promise.race([
        handleInbound({ channel: "whatsapp", externalId, text: "ya hice el pago", timestamp: new Date().toISOString() }, adaptadorFalso as any),
        new Promise((r) => setTimeout(r, 25000)),
      ]);
    } catch (e) {
      console.log(`  (excepción al final del turno): ${(e as Error).message}`);
    }

    const entregado = enviados[enviados.length - 1] ?? "(NO SE ENVIÓ NADA)";
    console.log("\n  ── MENSAJE AL CLIENTE ──");
    console.log(entregado.split("\n").map((l) => "  | " + l).join("\n"));
    console.log(`\n  consultas a Bold: ${consultasABold.length} · registros en la base: ${rpcsLlamados.filter((r) => r.nombre === "fn_registrar_pago_aprobado").length}`);

    const fallas = caso.revisar(entregado);
    if (fallas.length) { for (const f of fallas) console.log(`  ❌ ${f}`); fallos++; }
    else console.log("  ✅ el caso pasó");
    void registroDelModelo;
  }

  console.log("\n" + "█".repeat(92));
  if (fallos === 0) console.log(`  RESULTADO: ✅ ${CASOS.length}/${CASOS.length} casos pasaron.`);
  else { console.log(`  RESULTADO: ❌ ${fallos} de ${CASOS.length} casos fallaron.`); process.exitCode = 1; }
  console.log("█".repeat(92) + "\n");
}

main().catch((e) => { console.error("Error corriendo la prueba:", e); process.exitCode = 1; });
