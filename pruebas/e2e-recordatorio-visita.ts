/**
 * PRUEBA: el recordatorio del día antes del check-in (pedido de Daniel, 2026-09-14).
 *
 * Tres reglas a probar:
 *   1. Siempre es cálido: "estamos emocionados", ofrece ayuda con cómo llegar / dudas.
 *   2. Si el cliente NO debe nada, o su plan se paga al llegar (domingo a jueves, sin puente),
 *      NUNCA menciona plata.
 *   3. Si el cliente SÍ debe algo y su plan se paga un día antes (viernes/sábado/domingo/pasadía),
 *      recuerda el saldo con el valor EXACTO de la base — nunca inventado.
 *   4. Si la reserva quedó cancelada entre que se programó el recordatorio y hoy, no manda nada.
 *
 * También prueba la fecha/hora que calcula `instanteDelRecordatorio` (un día antes del check-in,
 * a la hora configurada) y que `programarRecordatorioVisita` no programa nada para una fecha que
 * ya está a menos de un día.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";

import { registerChannel } from "../src/channels/registry.js";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const enviados: string[] = [];
const adaptador = { name: "whatsapp", async send(m: { to: string; text?: string }) { enviados.push(m.text ?? ""); } };
registerChannel(adaptador);

const { ejecutarRecordatorioVisita, saldoSePagaUnDiaAntes } = await import("../src/core/pipeline/recordatorioVisita.js");
const {
  instanteDelRecordatorio, programarRecordatorioVisita, RECORDATORIO_VISITA_HORA_UTC, getRecordatorioQueue, jobIdRecordatorio,
} = await import("../src/core/queue/recordatorioQueue.js");

const RESERVA = 301;
const CHAT = "+573007770301";
const TOTAL = 700000;

function sembrar(opts: { saldo: number; fechaCheckin: string; plan?: string; estadoReserva?: string }) {
  const r = filasDe("reservas"); r.length = 0;
  r.push({ id: RESERVA, cliente_id: 1, fecha_reservada: opts.fechaCheckin, numero_huespedes: 2, planes: { nombre: opts.plan ?? "PLAN INTERMEDIO" } });

  const c = filasDe("clientes"); c.length = 0;
  c.push({ id: 1, nombre: "Laura Restrepo", celular: "3007770301" });

  const e = filasDe("estado_conversacion"); e.length = 0;
  e.push({ canal: "whatsapp", external_id: CHAT, last_agent: "postventa", updated_at: new Date().toISOString() });

  const v = filasDe("v_estado_cuenta"); v.length = 0;
  v.push({
    reserva_id: RESERVA, cliente_id: 1, cliente: "Laura Restrepo", celular: "3007770301",
    fecha_checkin: opts.fechaCheckin, total: TOTAL, pagado: TOTAL - opts.saldo, saldo: opts.saldo,
    estado_pago: opts.saldo > 0 ? "con_anticipo" : "pagada_total",
    estado_reserva: opts.estadoReserva ?? "confirmada", num_pagos: 1,
  });

  enviados.length = 0;
}

const JOB = { reservaId: RESERVA, canal: "whatsapp", externalId: CHAT };

let fallas = 0;

function chequear(nombre: string, cond: boolean, detalle: string) {
  if (cond) { console.log(`  ✅ ${nombre}`); }
  else { console.log(`  ❌ ${nombre} — ${detalle}`); fallas++; }
}

console.log("\n" + "█".repeat(94));
console.log("  PRUEBA — recordatorio del día antes del check-in");
console.log("█".repeat(94));

console.log("\nCASO 1. Sábado, con saldo pendiente: recuerda la plata con el valor exacto\n");
{
  sembrar({ saldo: 350000, fechaCheckin: "2026-10-17" }); // 2026-10-17 es sábado
  await ejecutarRecordatorioVisita(JOB);
  const msg = enviados[0] ?? "";
  console.log(msg.split("\n").map((l) => "  | " + l).join("\n"));
  chequear("le escribió algo", !!msg, "no mandó ningún mensaje");
  chequear("suena cálido / emocionado", /emocionad|felices/i.test(msg), "no transmite el tono cálido pedido");
  chequear("ofrece ayuda con cómo llegar / dudas", /cómo llegar|duda/i.test(msg), "no ofrece ayuda con dudas ni cómo llegar");
  chequear("menciona el saldo con el valor correcto", msg.includes("350.000"), "no trae el valor exacto del saldo");
}

console.log("\nCASO 2. Sábado, SIN saldo pendiente: no menciona plata para nada\n");
{
  sembrar({ saldo: 0, fechaCheckin: "2026-10-17" });
  await ejecutarRecordatorioVisita(JOB);
  const msg = enviados[0] ?? "";
  chequear("le escribió algo", !!msg, "no mandó ningún mensaje");
  chequear("NO menciona saldo/plata", !/saldo|pagar|\$/i.test(msg), `mencionó plata sin deber nada: "${msg}"`);
}

console.log("\nCASO 3. Martes (entre semana, sin puente), CON saldo: el plan se paga al llegar — no se menciona\n");
{
  sembrar({ saldo: 350000, fechaCheckin: "2026-10-13" }); // 2026-10-13 es martes
  await ejecutarRecordatorioVisita(JOB);
  const msg = enviados[0] ?? "";
  chequear("le escribió algo (el saludo cálido igual va)", !!msg, "no mandó ningún mensaje");
  chequear("NO menciona el saldo (se paga al llegar, no un día antes)", !/saldo|pagar|\$/i.test(msg), `mencionó plata cuando el plan paga al llegar: "${msg}"`);
}

console.log("\nCASO 4. Pasadía entre semana, CON saldo: los pasadías SIEMPRE recuerdan la plata\n");
{
  sembrar({ saldo: 120000, fechaCheckin: "2026-10-13", plan: "PASADÍA PAREJA" }); // martes, pero pasadía
  await ejecutarRecordatorioVisita(JOB);
  const msg = enviados[0] ?? "";
  chequear("menciona el saldo (pasadía, aunque sea martes)", msg.includes("120.000"), `no recordó el saldo de un pasadía: "${msg}"`);
}

console.log("\nCASO 5. La reserva quedó cancelada: no manda nada\n");
{
  sembrar({ saldo: 350000, fechaCheckin: "2026-10-17", estadoReserva: "Cancelada" });
  await ejecutarRecordatorioVisita(JOB);
  chequear("no le escribió nada", enviados.length === 0, `le escribió pese a estar cancelada: "${enviados[0]}"`);
}

console.log("\nCASO 6. saldoSePagaUnDiaAntes: viernes/sábado/domingo y pasadía sí, resto no\n");
{
  const casos: [string, string | undefined, boolean][] = [
    ["2026-10-16", undefined, true],  // viernes
    ["2026-10-17", undefined, true],  // sábado
    ["2026-10-18", undefined, true],  // domingo
    ["2026-10-13", undefined, false], // martes
    ["2026-10-15", undefined, false], // jueves
    ["2026-10-13", "PASADÍA AMIGAS", true], // martes, pero pasadía
  ];
  for (const [fecha, plan, esperado] of casos) {
    const real = saldoSePagaUnDiaAntes(fecha, plan);
    chequear(`${fecha}${plan ? ` (${plan})` : ""} -> ${esperado}`, real === esperado, `dio ${real}`);
  }
}

console.log("\nCASO 7. instanteDelRecordatorio: un día antes del check-in, a la hora configurada\n");
{
  const instante = instanteDelRecordatorio("2026-10-17");
  const esperado = new Date(Date.UTC(2026, 9, 16, RECORDATORIO_VISITA_HORA_UTC, 0, 0));
  chequear(
    "cae exactamente un día antes, a la hora configurada",
    instante?.getTime() === esperado.getTime(),
    `dio ${instante?.toISOString()}, esperaba ${esperado.toISOString()}`
  );
}

console.log("\nCASO 8. programarRecordatorioVisita no programa nada si el check-in ya está a menos de un día\n");
{
  const mañana = new Date(Date.now() + 12 * 60 * 60 * 1000); // en 12h — ya no alcanza para "un día antes"
  const fechaISO = mañana.toISOString().slice(0, 10);
  try {
    await programarRecordatorioVisita({ reservaId: 9999, canal: "whatsapp", externalId: CHAT, fechaCheckinISO: fechaISO });
    const job = await getRecordatorioQueue().getJob(jobIdRecordatorio(9999));
    chequear("no quedó ningún job programado", !job, "programó un recordatorio para una fecha ya vencida");
  } catch (err) {
    console.log(`  (sin Redis local disponible — se saltea este caso: ${(err as Error).message})`);
  }
}

console.log("\n" + "█".repeat(94));
if (fallas === 0) console.log("  RESULTADO: ✅ todos los casos pasaron.");
else { console.log(`  RESULTADO: ❌ ${fallas} falla(s).`); process.exitCode = 1; }
console.log("█".repeat(94) + "\n");

void import("../src/core/queue/redis.js").then(({ getRedisConnection }) => {
  try { getRedisConnection().disconnect(); } catch { /* nada que cerrar */ }
});
