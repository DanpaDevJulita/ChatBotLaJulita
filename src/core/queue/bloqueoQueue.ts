import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";

export const QUEUE_BLOQUEO = "bloqueo";

export interface BloqueoJob {
  bloqueoId: number;
  canal: string;
  externalId: string;
}

/** Cuántos minutos dura el bloqueo antes de liberarse solo. Confirmado con el equipo: 10. */
export const BLOQUEO_MINUTOS = Number(process.env.BLOQUEO_MINUTOS ?? 10);

let queue: Queue<BloqueoJob> | null = null;

export function getBloqueoQueue(): Queue<BloqueoJob> {
  if (!queue) {
    queue = new Queue<BloqueoJob>(QUEUE_BLOQUEO, {
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

function jobIdDe(bloqueoId: number): string {
  return `bloqueo-${bloqueoId}`;
}

/**
 * Programa la liberación automática de un bloqueo recién creado. El worker, cuando el job se
 * dispare, vuelve a chequear el estado en la base antes de hacer nada (ver
 * src/core/pipeline/bloqueo.ts) — así que si el equipo ya confirmó el pago con /confirmar, el
 * job dispara igual pero no hace nada (o mejor: se cancela con `cancelarLiberacion` abajo,
 * pero esto es un respaldo por si esa cancelación llega tarde).
 */
export async function programarLiberacion(bloqueoId: number, canal: string, externalId: string): Promise<void> {
  try {
    await getBloqueoQueue().add(
      "liberar",
      { bloqueoId, canal, externalId },
      { jobId: jobIdDe(bloqueoId), delay: BLOQUEO_MINUTOS * 60_000 }
    );
    console.log(`[bloqueo] Programada la liberación del bloqueo #${bloqueoId} en ${BLOQUEO_MINUTOS} min.`);
  } catch (err) {
    console.error(`[bloqueo] No pude programar la liberación del bloqueo #${bloqueoId}:`, err);
  }
}

/** El equipo confirmó el pago antes de tiempo (/confirmar): ya no hace falta liberarlo. */
export async function cancelarLiberacion(bloqueoId: number): Promise<void> {
  try {
    const job = await getBloqueoQueue().getJob(jobIdDe(bloqueoId));
    if (job) await job.remove();
  } catch (err) {
    console.warn(`[bloqueo] No pude cancelar la liberación del bloqueo #${bloqueoId}:`, (err as Error).message);
  }
}
