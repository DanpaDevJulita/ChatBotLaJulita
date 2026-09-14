import { getChannel } from "../../channels/registry.js";
import { insertMensaje } from "../db/mensajesRepo.js";
import { obtenerEstadoCuenta, resumenDeReserva } from "../db/pagosRepo.js";
import { recordarReservaActiva } from "../db/conversacionActivaRepo.js";
import { fechaCorta } from "../lib/fechas.js";
import { enviarSeguro } from "./enviar.js";
import { registrarMensajeDelBot } from "./runTurn.js";
import type { RecordatorioVisitaJob } from "../queue/recordatorioQueue.js";

/**
 * [2026-09-14] El recordatorio de "un día antes" que pidió Daniel: cálido, ofrece ayuda con cómo
 * llegar o cualquier duda de último momento, y SOLO si de verdad hace falta, recuerda el saldo
 * pendiente con el valor exacto — nunca inventado, siempre lo que diga `v_estado_cuenta` en el
 * instante en que se dispara el job (no lo que había cuando se programó: puede haber cambiado).
 *
 * Si no debe nada, no se menciona la plata para nada — pedido explícito.
 */

function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

function primerNombre(nombreCompleto: string | null | undefined): string | null {
  const primero = (nombreCompleto ?? "").trim().split(/\s+/)[0];
  return primero ? primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase() : null;
}

/**
 * [2026-09-14] Según la política oficial `saldo_pendiente` (ver sql/politicas.sql): el saldo se
 * paga un día antes del check-in si la llegada es viernes, sábado, domingo de puente festivo, o
 * si es un pasadía. De domingo a jueves (que no sea puente) se paga al llegar — ese caso NO
 * necesita este recordatorio de pago.
 *
 * OJO — limitación conocida (la misma que ya tiene `tarifaDeFecha` en planes.ts, ver el
 * comentario ahí): sin un calendario de festivos colombianos no se puede distinguir un domingo
 * de puente de un domingo normal. Se prefiere recordar de más (un domingo normal recibe el
 * recordatorio un día antes cuando en teoría podía esperar a que llegara) antes que de menos —
 * el peor caso de recordar de más es un mensaje con un día de anticipación, no una reserva que se
 * queda sin cobrar.
 */
export function saldoSePagaUnDiaAntes(fechaCheckinISO: string | null | undefined, plan: string | null | undefined): boolean {
  if (/pasad[ií]a/i.test(plan ?? "")) return true;
  const m = (fechaCheckinISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return dow === 5 || dow === 6 || dow === 0; // viernes, sábado, domingo
}

const ESTADOS_QUE_CANCELAN_EL_RECORDATORIO = /cancelad/i;

export async function ejecutarRecordatorioVisita(job: RecordatorioVisitaJob): Promise<void> {
  const key = `${job.canal}:${job.externalId}`;

  const [cuenta, resumen] = await Promise.all([obtenerEstadoCuenta(job.reservaId), resumenDeReserva(job.reservaId)]);

  if (!cuenta) {
    console.warn(`[recordatorioVisita] reserva #${job.reservaId}: no encontré la cuenta — no mando nada.`);
    return;
  }

  // Si el equipo canceló la reserva a mano (o cambió el estado por lo que sea) entre que se
  // programó el recordatorio y hoy, no tiene sentido decirle "estamos emocionados de tu visita".
  if (ESTADOS_QUE_CANCELAN_EL_RECORDATORIO.test(cuenta.estado_reserva ?? "")) {
    console.log(
      `[recordatorioVisita] reserva #${job.reservaId}: estado "${cuenta.estado_reserva}" — no mando el recordatorio.`
    );
    return;
  }

  const nombre = primerNombre(cuenta.cliente);
  const fechaCheckin = resumen?.fecha ?? cuenta.fecha_checkin ?? null;
  const cuando = fechaCheckin ? fechaCorta(fechaCheckin) : null;
  const plan = resumen?.plan ?? null;

  const saludo = nombre ? `¡Hola, ${nombre}! 💚` : "¡Hola! 💚";
  const partes: string[] = [
    `${saludo} Ya casi es tu día en La Julita${cuando ? ` — mañana, ${cuando}` : ""} y estamos súper emocionados de recibirte 🏕️`,
    "Si te queda alguna duda de cómo llegar, del clima, o de cualquier otra cosa antes de tu visita, escríbeme con toda confianza, con gusto te ayudo.",
  ];

  const debeAlgo = cuenta.saldo > 0;
  if (debeAlgo && saldoSePagaUnDiaAntes(fechaCheckin, plan)) {
    partes.push(
      `Un detalle antes de que llegues: según tu reserva, te queda un saldo de ${formatMoney(cuenta.saldo)} por pagar. ` +
        "Si quieres, dime y te paso el link para dejarlo listo antes de tu llegada 😊"
    );
  }
  // Si no debe nada, o si su plan paga al llegar (domingo a jueves, sin puente), no se menciona
  // la plata para nada — así lo pidió Daniel.

  const texto = partes.join("\n\n");

  let adapter;
  try {
    adapter = getChannel(job.canal);
  } catch (err) {
    console.error(`[recordatorioVisita] ${key}: no hay adaptador registrado para ese canal:`, err);
    return;
  }

  const entregado = await enviarSeguro(adapter, job.externalId, texto, key);
  if (!entregado) {
    console.error(`[recordatorioVisita] ${key}: no pude entregarle el recordatorio al cliente.`);
    return;
  }

  registrarMensajeDelBot(job.canal, job.externalId, texto);
  await insertMensaje({
    canal: job.canal,
    external_id: job.externalId,
    role: "assistant",
    content: texto,
    agent_name: "recordatorio-visita",
  });

  // [2026-09-14] Si el cliente contesta pidiendo pagar el saldo, `enviar_datos_pago`/`verificar_pago`
  // tienen que resolver ESTA reserva, no "la última de este celular" — se refresca
  // `reserva_activa_id` con el mismo TTL de 6h que ya usa el resto del flujo de pagos, para que la
  // ventana quede vigente otra vez a partir de este mensaje (si no, después de días de silencio
  // desde que se registró la reserva, el TTL original ya estaría vencido).
  await recordarReservaActiva(job.canal, job.externalId, job.reservaId).catch((err) =>
    console.warn(`[recordatorioVisita] ${key}: no pude refrescar la reserva activa:`, err)
  );

  console.log(`[recordatorioVisita] ${key}: recordatorio del día antes mandado para la reserva #${job.reservaId}.`);
}
