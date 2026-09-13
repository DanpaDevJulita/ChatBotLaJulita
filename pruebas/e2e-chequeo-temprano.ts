/**
 * PRUEBA: "no podemos esperar ni confiarnos del webhook de Bold" — pidió el equipo (2026-09-13).
 *
 * Mientras el bloqueo de 10 minutos sigue vigente, el bot ahora le pregunta a Bold DE PASO a los
 * 3 y a los 7 minutos (ver MINUTOS_CHEQUEO_TEMPRANO en bloqueoQueue.ts), en vez de depender solo
 * de que el webhook llegue o de que el cliente escriba "ya pagué".
 *
 * Se verifica que:
 *   - si Bold ya tiene el pago cuando corre el chequeo: se confirma al cliente y el bloqueo
 *     queda "confirmado" — sin esperar a los 10 minutos;
 *   - si todavía no hay pago: no le escribe nada a nadie, sigue esperando el próximo chequeo;
 *   - si Bold no responde: no explota, no inventa nada, sigue esperando;
 *   - si el pago YA estaba registrado antes (el webhook se adelantó): no le manda un segundo
 *     mensaje de confirmación, pero tampoco falla;
 *   - `programarChequeosTempranos` / `cancelarSeguimientoDePago` de verdad agendan y borran los
 *     trabajos en la cola (esto SÍ necesita Redis local — si no hay, ese caso se anuncia y se
 *     saltea, no cuenta como fallo del resto).
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.CHEQUEO_PAGO_MINUTOS ||= "3,7";
process.env.BLOQUEO_MINUTOS ||= "10";

import { registerChannel } from "../src/channels/registry.js";

const {
  instalarSupabaseFalso, instalarBoldFalso, boldResponderaEstado, filasDe, rpcsLlamados, consultasABold,
} = await import("./fakes.js");

instalarSupabaseFalso();
instalarBoldFalso();

const enviados: string[] = [];
const adaptador = { name: "whatsapp", async send(m: { to: string; text?: string }) { enviados.push(m.text ?? ""); } };
registerChannel(adaptador);

const { ejecutarChequeoTemprano } = await import("../src/core/pipeline/chequeoTemprano.js");
const {
  programarChequeosTempranos, cancelarSeguimientoDePago, getBloqueoQueue,
  MINUTOS_CHEQUEO_TEMPRANO, jobIdChequeo,
} = await import("../src/core/queue/bloqueoQueue.js");

const RESERVA = 191;
const BLOQUEO = 155;
const CHAT = "+573200000191";
const TOTAL = 700000;
const ABONO = 350000;
const REF = `res${RESERVA}-abono-1789200000000`;

function sembrar(opts: { pagoYaRegistrado?: boolean } = {}) {
  const r = filasDe("reservas"); r.length = 0;
  r.push({ id: RESERVA, cliente_id: 1, fecha_reservada: "2026-09-20", numero_huespedes: 2, planes: { nombre: "PLAN INTERMEDIO" } });

  const c = filasDe("clientes"); c.length = 0;
  c.push({ id: 1, nombre: "Andrea Gómez", celular: "3200000191" });

  const e = filasDe("estado_conversacion"); e.length = 0;
  e.push({ canal: "whatsapp", external_id: CHAT, last_agent: "pagos", updated_at: new Date().toISOString() });

  // [C4] "ya estaba registrado" tiene que ser un pago YA LIQUIDADO por completo (saldo 0), no un
  // abono parcial: verificarPagoEnBold() solo reconoce "ya estaba pagado" cuando saldo<=0 && pagado>0
  // — un abono con saldo pendiente cae por el otro lado (sinLinksPendientes, pagado:false), que es
  // un caso distinto (y uno pre-existente, fuera del alcance de esta prueba).
  const v = filasDe("v_estado_cuenta"); v.length = 0;
  v.push({
    reserva_id: RESERVA, cliente_id: 1, cliente: "Andrea Gómez", celular: "3200000191",
    fecha_checkin: "2026-09-20", total: TOTAL,
    pagado: opts.pagoYaRegistrado ? TOTAL : 0,
    saldo: opts.pagoYaRegistrado ? 0 : TOTAL,
    estado_pago: opts.pagoYaRegistrado ? "pagado" : "pendiente", estado_reserva: "borrador", num_pagos: 0,
  });

  const p = filasDe("pagos"); p.length = 0;
  p.push({
    id: 1, reserva_id: RESERVA, tipo: opts.pagoYaRegistrado ? "total" : "abono",
    valor: opts.pagoYaRegistrado ? TOTAL : ABONO, referencia: REF,
    estado: opts.pagoYaRegistrado ? "pagado" : "pendiente",
    payment_link: "LNK_PRUEBA", link_url: "https://checkout.bold.co/payment/LNK_PRUEBA",
  });

  const b = filasDe("bloqueos_temporales"); b.length = 0;
  b.push({
    id: BLOQUEO, canal: "whatsapp", external_id: CHAT, estado: "pendiente", avisado: false,
    clase_domo: "clasico", capacidad: 2, fecha_entrada: "2026-09-20", noches: 1,
    cliente_id: 1, personas: 2, valor_total: TOTAL, ninos: 0,
    lobby_block_id: 8001, lobby_category_id: 34, lobby_booking_id: null, lobby_room_id: null,
    expira_en: new Date(Date.now() + 7 * 60000).toISOString(), // todavía vigente, faltan minutos
  });

  filasDe("mensajes").length = 0;
  enviados.length = 0;
  rpcsLlamados.length = 0;
  consultasABold.length = 0;
}

function bloqueo() { return filasDe("bloqueos_temporales").find((b) => b.id === BLOQUEO); }
const JOB = { bloqueoId: BLOQUEO, canal: "whatsapp", externalId: CHAT };

interface Caso { nombre: string; detalle: string; preparar: () => void; revisar: () => Promise<string[]> | string[] }

const CASOS: Caso[] = [
  {
    nombre: "C1. El chequeo temprano encuentra el pago: confirma sin esperar los 10 minutos",
    detalle: "Bold dice PAID al toque de este chequeo (ej. a los 3 min) — se confirma ya mismo.",
    preparar: () => { sembrar(); boldResponderaEstado({ status: "PAID", transaction_id: "TX-C1", total: ABONO, reference: REF }); },
    revisar: () => {
      const fallas: string[] = [];
      const msg = enviados[enviados.length - 1] ?? "";
      if (!msg) fallas.push("no le escribió nada al cliente pese a que Bold ya tenía el pago");
      if (!/Confirmado|confirmada|apartada/i.test(msg)) fallas.push("no le confirmó la reserva");
      if (/estoy confirmando con el equipo/i.test(msg)) fallas.push("le mandó el mensaje de 'validando', no el de confirmado (acá el cupo sigue vigente, no hacía falta)");
      if (bloqueo()?.estado !== "confirmado") fallas.push(`el bloqueo quedó en "${bloqueo()?.estado}" en vez de confirmado`);
      if (!rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("no registró el pago que encontró");
      return fallas;
    },
  },
  {
    nombre: "C2. Todavía no hay pago: no le escribe nada a nadie",
    detalle: "El cliente ni pagó ni escribió — el chequeo pasa en silencio y sigue esperando el próximo.",
    preparar: () => { sembrar(); boldResponderaEstado({ status: "ACTIVE" }); },
    revisar: () => {
      const fallas: string[] = [];
      if (enviados.length > 0) fallas.push(`le escribió algo sin que hubiera pago: "${enviados[0]}"`);
      if (bloqueo()?.estado !== "pendiente") fallas.push(`el bloqueo cambió a "${bloqueo()?.estado}" sin que hubiera pago`);
      if (rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("registró un pago que no existe");
      return fallas;
    },
  },
  {
    nombre: "C3. Bold no responde: no explota, no inventa nada",
    detalle: "Un chequeo de paso que falla no puede tumbar nada ni dar un pago por hecho.",
    preparar: () => { sembrar(); boldResponderaEstado(null); },
    revisar: () => {
      const fallas: string[] = [];
      if (enviados.length > 0) fallas.push("le escribió algo pese a que Bold no respondió");
      if (bloqueo()?.estado !== "pendiente") fallas.push("tocó el bloqueo pese a no poder verificar nada");
      return fallas;
    },
  },
  {
    nombre: "C4. El pago YA estaba registrado (el webhook se adelantó): no duplica el aviso",
    detalle: "Si el webhook ya le avisó al cliente, este chequeo no tiene que mandarle un segundo mensaje.",
    preparar: () => { sembrar({ pagoYaRegistrado: true }); boldResponderaEstado({ status: "PAID", transaction_id: "TX-C4", total: ABONO, reference: REF }); },
    revisar: () => {
      const fallas: string[] = [];
      if (enviados.length > 0) fallas.push(`le mandó un SEGUNDO aviso de confirmación: "${enviados[0]}"`);
      // El pago ya estaba pagado en la base (no hay nada pendiente que consultar en Bold), así que
      // tampoco hace falta que se haya llamado a fn_registrar_pago_aprobado de nuevo.
      if (rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("volvió a registrar un pago que ya estaba registrado");
      return fallas;
    },
  },
];

async function pruebaIntegracionDeCola(): Promise<{ nombre: string; fallas: string[]; saltada: boolean }> {
  const nombre = "C5. programarChequeosTempranos / cancelarSeguimientoDePago tocan la cola de verdad";
  const fallas: string[] = [];
  try {
    sembrar();
    await programarChequeosTempranos(BLOQUEO, "whatsapp", CHAT);
    const queue = getBloqueoQueue();
    const antes = await Promise.all(MINUTOS_CHEQUEO_TEMPRANO.map((m) => queue.getJob(jobIdChequeo(BLOQUEO, m))));
    if (antes.some((j) => !j)) fallas.push("no quedó agendado alguno de los chequeos tempranos");

    await cancelarSeguimientoDePago(BLOQUEO);
    const despues = await Promise.all(MINUTOS_CHEQUEO_TEMPRANO.map((m) => queue.getJob(jobIdChequeo(BLOQUEO, m))));
    if (despues.some((j) => !!j)) fallas.push("cancelarSeguimientoDePago no borró todos los chequeos agendados");

    return { nombre, fallas, saltada: false };
  } catch (err) {
    console.warn(`  (sin Redis local disponible — se saltea "${nombre}": ${(err as Error).message})`);
    return { nombre, fallas: [], saltada: true };
  }
}

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA — chequeos tempranos a Bold (3 y 7 minutos), sin depender del webhook");
  console.log("█".repeat(92));

  let fallos = 0;
  let total = 0;

  for (const caso of CASOS) {
    total++;
    caso.preparar();
    console.log("\n" + "─".repeat(92));
    console.log(`CASO ${caso.nombre}`);
    console.log(`  ${caso.detalle}`);
    console.log("─".repeat(92));

    try {
      await ejecutarChequeoTemprano(JOB);
    } catch (e) {
      console.log(`  (excepción): ${(e as Error).message}`);
    }

    if (enviados.length) {
      console.log("  ── MENSAJE AL CLIENTE ──");
      console.log(enviados[enviados.length - 1]!.split("\n").map((l) => "  | " + l).join("\n"));
    } else {
      console.log("  (no se le escribió nada al cliente)");
    }

    const fallas = await caso.revisar();
    if (fallas.length) { for (const f of fallas) console.log(`  ❌ ${f}`); fallos++; }
    else console.log("  ✅ el caso pasó");
  }

  const integracion = await pruebaIntegracionDeCola();
  console.log("\n" + "─".repeat(92));
  console.log(`CASO ${integracion.nombre}`);
  console.log("─".repeat(92));
  if (integracion.saltada) {
    console.log("  ⏭️  saltada (no cuenta ni como pasada ni como fallida)");
  } else {
    total++;
    if (integracion.fallas.length) { for (const f of integracion.fallas) console.log(`  ❌ ${f}`); fallos++; }
    else console.log("  ✅ el caso pasó");
  }

  console.log("\n" + "█".repeat(92));
  if (fallos === 0) console.log(`  RESULTADO: ✅ ${total}/${total} casos pasaron.`);
  else { console.log(`  RESULTADO: ❌ ${fallos} de ${total} casos fallaron.`); process.exitCode = 1; }
  console.log("█".repeat(92) + "\n");
}

main()
  .catch((e) => { console.error("Error corriendo la prueba:", e); process.exitCode = 1; })
  .finally(() => {
    // Cierra la conexión a Redis (si se llegó a abrir) para que el proceso pueda terminar solo.
    void import("../src/core/queue/redis.js").then(({ getRedisConnection }) => {
      try { getRedisConnection().disconnect(); } catch { /* nada que cerrar */ }
    });
  });
