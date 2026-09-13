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

/**
 * [2026-09-13] "No podemos esperar ni confiarnos del webhook de Bold": además del chequeo único
 * de antes de liberar (a los BLOQUEO_MINUTOS), se le pregunta a Bold por lo bajo un par de veces
 * MIENTRAS el cupo sigue apartado — por defecto a los 3 y a los 7 minutos — para no depender
 * solo de que el webhook llegue o de que el cliente escriba "ya pagué".
 *
 * Se filtran los que caerían en o después de BLOQUEO_MINUTOS (no tendría sentido chequear a los
 * 12 minutos si el cupo ya se libera a los 10) — así, si alguien baja BLOQUEO_MINUTOS a 1 para
 * probar, esto no programa chequeos que nunca llegarían a dispararse dentro de la ventana.
 */
export const MINUTOS_CHEQUEO_TEMPRANO: number[] = (process.env.CHEQUEO_PAGO_MINUTOS ?? "3,7")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0 && n < BLOQUEO_MINUTOS)
  .sort((a, b) => a - b);

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

export function jobIdDe(bloqueoId: number): string {
  return `bloqueo-${bloqueoId}`;
}

export function jobIdChequeo(bloqueoId: number, minuto: number): string {
  return `bloqueo-${bloqueoId}-chequeo-${minuto}`;
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

/**
 * [2026-09-13] Programa los chequeos tempranos (ver MINUTOS_CHEQUEO_TEMPRANO) — se llama en el
 * mismo momento y con los mismos datos que `programarLiberacion` (mismo reloj: arranca a contar
 * desde que se crea el bloqueo, justo antes de mandarle el link de pago al cliente).
 *
 * Igual que la liberación: si a esa altura el bloqueo ya no está pendiente (se confirmó por
 * cualquier otro camino), el handler del job no hace nada — ver ejecutarChequeoTemprano.
 */
export async function programarChequeosTempranos(bloqueoId: number, canal: string, externalId: string): Promise<void> {
  for (const minuto of MINUTOS_CHEQUEO_TEMPRANO) {
    try {
      await getBloqueoQueue().add(
        "chequeo-temprano",
        { bloqueoId, canal, externalId },
        { jobId: jobIdChequeo(bloqueoId, minuto), delay: minuto * 60_000 }
      );
    } catch (err) {
      console.error(`[bloqueo] No pude programar el chequeo temprano de los ${minuto} min para el bloqueo #${bloqueoId}:`, err);
    }
  }
  if (MINUTOS_CHEQUEO_TEMPRANO.length > 0) {
    console.log(`[bloqueo] Programados chequeos tempranos del bloqueo #${bloqueoId} a los ${MINUTOS_CHEQUEO_TEMPRANO.join(" y ")} min.`);
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

/** Cancela los chequeos tempranos que todavía no se hayan disparado. Best-effort: si alguno ya
 * está corriendo (o ya se disparó), simplemente no hay nada que cancelar ahí. */
export async function cancelarChequeosTempranos(bloqueoId: number): Promise<void> {
  for (const minuto of MINUTOS_CHEQUEO_TEMPRANO) {
    try {
      const job = await getBloqueoQueue().getJob(jobIdChequeo(bloqueoId, minuto));
      if (job) await job.remove();
    } catch (err) {
      console.warn(`[bloqueo] No pude cancelar el chequeo temprano de los ${minuto} min del bloqueo #${bloqueoId}:`, (err as Error).message);
    }
  }
}

/**
 * [2026-09-13] "Si en algún momento llega el webhook confirmando el pago, ya no se hace ninguna
 * consulta": una vez que el pago queda confirmado por CUALQUIER camino (el webhook de Bold, el
 * cliente diciendo "ya pagué", o uno de los chequeos tempranos de acá), no tiene sentido seguir
 * preguntándole a Bold — se cancela todo lo que quede pendiente para ese bloqueo de una vez.
 */
export async function cancelarSeguimientoDePago(bloqueoId: number): Promise<void> {
  await Promise.all([cancelarLiberacion(bloqueoId), cancelarChequeosTempranos(bloqueoId)]);
}
