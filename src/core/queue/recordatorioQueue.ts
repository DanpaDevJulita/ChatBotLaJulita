import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";

export const QUEUE_RECORDATORIO_VISITA = "recordatorio-visita";

export interface RecordatorioVisitaJob {
  reservaId: number;
  canal: string;
  externalId: string;
}

/**
 * [2026-09-14] Recordatorio del glamping a la reserva confirmada, un día antes del check-in —
 * pedido explícito de Daniel: "estamos emocionados de tu visita", ofrecer ayuda con cómo llegar
 * o cualquier duda, y (solo si aplica) recordar el saldo pendiente.
 *
 * A qué hora: 9:00 a. m. hora de Colombia (UTC-5, sin horario de verano) por defecto — ni
 * demasiado temprano ni tan tarde que se sienta apurado. Configurable por si el equipo lo quiere
 * mover, sin tocar código.
 */
export const RECORDATORIO_VISITA_HORA_UTC = Number(process.env.RECORDATORIO_VISITA_HORA_UTC ?? 14);

let queue: Queue<RecordatorioVisitaJob> | null = null;

export function getRecordatorioQueue(): Queue<RecordatorioVisitaJob> {
  if (!queue) {
    queue = new Queue<RecordatorioVisitaJob>(QUEUE_RECORDATORIO_VISITA, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  }
  return queue;
}

export function jobIdRecordatorio(reservaId: number): string {
  return `recordatorio-visita-${reservaId}`;
}

/**
 * A qué hora UTC cae "un día antes, a las RECORDATORIO_VISITA_HORA_UTC" para una fecha de
 * check-in AAAA-MM-DD. Igual que `fechas.ts`: la fecha de check-in es una fecha de calendario
 * (no un instante), así que se ancla en UTC a propósito — moverla a la zona del server correría
 * el día.
 */
export function instanteDelRecordatorio(fechaCheckinISO: string): Date | null {
  const m = (fechaCheckinISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const checkin = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const unDiaAntes = checkin - 24 * 60 * 60 * 1000;
  return new Date(unDiaAntes + RECORDATORIO_VISITA_HORA_UTC * 60 * 60 * 1000);
}

/**
 * Programa el recordatorio del día antes. Se llama UNA sola vez, justo cuando la reserva queda
 * realmente creada en LobbyPMS (ver confirmarReserva.ts) — es el primer momento en que la fecha
 * de check-in es una promesa firme, no un bloqueo temporal que todavía se puede vencer.
 *
 * Si la fecha ya quedó a menos de un día (una reserva de último momento, para mañana o para hoy)
 * no tiene sentido programar nada: se seguiría el mismo instante, en el pasado, y BullMQ lo
 * dispararía de inmediato — mejor no mandar un "recordatorio" fuera de tiempo. Se loguea y ya.
 */
export async function programarRecordatorioVisita(params: {
  reservaId: number;
  canal: string;
  externalId: string;
  fechaCheckinISO: string | null | undefined;
}): Promise<void> {
  const instante = params.fechaCheckinISO ? instanteDelRecordatorio(params.fechaCheckinISO) : null;
  if (!instante) {
    console.warn(
      `[recordatorioVisita] reserva #${params.reservaId}: sin fecha de check-in válida, no programo el recordatorio.`
    );
    return;
  }

  const delay = instante.getTime() - Date.now();
  if (delay <= 0) {
    console.log(
      `[recordatorioVisita] reserva #${params.reservaId}: el check-in es en menos de un día (o ya pasó) — ` +
        "no tiene sentido un recordatorio 'de un día antes', no se programa."
    );
    return;
  }

  try {
    await getRecordatorioQueue().add(
      "recordatorio",
      { reservaId: params.reservaId, canal: params.canal, externalId: params.externalId },
      { jobId: jobIdRecordatorio(params.reservaId), delay }
    );
    console.log(
      `[recordatorioVisita] reserva #${params.reservaId}: programado el recordatorio para ${instante.toISOString()}.`
    );
  } catch (err) {
    console.error(`[recordatorioVisita] reserva #${params.reservaId}: no pude programar el recordatorio:`, err);
  }
}

/** Por si la reserva se cancela antes del recordatorio (hoy solo lo usa /confirmar-cancelaciones a mano, si existe). */
export async function cancelarRecordatorioVisita(reservaId: number): Promise<void> {
  try {
    const job = await getRecordatorioQueue().getJob(jobIdRecordatorio(reservaId));
    if (job) await job.remove();
  } catch (err) {
    console.warn(`[recordatorioVisita] No pude cancelar el recordatorio de la reserva #${reservaId}:`, (err as Error).message);
  }
}
