import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";
import { ajustarPorHorarioNocturno } from "../lib/horarioNocturno.js";

export const QUEUE_RECONTACTO = "recontacto";

export interface RecontactoJob {
  canal: string;
  externalId: string;
  /** 1, 2 o 3: qué recontacto de la cadena toca mandar. */
  paso: number;
  /** ISO del último mensaje del bot: si el cliente escribió después, el recontacto se cancela. */
  ancla: string;
}

/** En false (FOLLOWUP_ENABLED=false) no se programa ningún recontacto. */
export const RECONTACTO_HABILITADO = process.env.FOLLOWUP_ENABLED !== "false";

/**
 * Cadena de recontactos, igual que en agente-ycloud-main: 20 minutos, 3 horas y 6 horas.
 * Los tres pasos caben dentro de la ventana de 24 horas de WhatsApp (contada desde el último
 * mensaje del cliente), así que se pueden mandar como texto libre sin plantilla aprobada.
 */
export const PASOS_MS: number[] = [
  Number(process.env.FOLLOWUP_1_MS ?? 20 * 60 * 1000),
  Number(process.env.FOLLOWUP_2_MS ?? 3 * 60 * 60 * 1000),
  Number(process.env.FOLLOWUP_3_MS ?? 6 * 60 * 60 * 1000),
];

export const MAX_PASOS = PASOS_MS.length;

let queue: Queue<RecontactoJob> | null = null;

export function getRecontactoQueue(): Queue<RecontactoJob> {
  if (!queue) {
    queue = new Queue<RecontactoJob>(QUEUE_RECONTACTO, {
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

/** Un solo recontacto pendiente por conversación: el jobId es fijo por canal + cliente. */
function jobIdDe(canal: string, externalId: string): string {
  return `recontacto-${canal}-${externalId}`;
}

export async function cancelarRecontacto(canal: string, externalId: string): Promise<void> {
  if (!RECONTACTO_HABILITADO) return;
  try {
    const job = await getRecontactoQueue().getJob(jobIdDe(canal, externalId));
    if (job) await job.remove();
  } catch (err) {
    // Si el job está "active" justo en este instante no se puede remover; el propio worker
    // vuelve a verificar antes de escribirle al cliente, así que no es un problema.
    console.warn(`[recontacto] No pude cancelar el pendiente de ${canal}:${externalId}:`, (err as Error).message);
  }
}

/**
 * Programa (o reprograma) el recontacto de una conversación. Se llama después de CADA
 * respuesta del bot con paso 1, así que mientras la charla siga viva el reloj se reinicia solo
 * y nunca hay más de un recontacto pendiente por cliente.
 */
export async function programarRecontacto(
  canal: string,
  externalId: string,
  paso: number,
  ancla: string
): Promise<void> {
  if (!RECONTACTO_HABILITADO) return;
  if (paso < 1 || paso > MAX_PASOS) return;

  await cancelarRecontacto(canal, externalId);

  const ahora = Date.now();
  const cuando = ajustarPorHorarioNocturno(ahora + PASOS_MS[paso - 1]);
  const delay = Math.max(0, cuando - ahora);

  try {
    await getRecontactoQueue().add(
      "recontactar",
      { canal, externalId, paso, ancla },
      { jobId: jobIdDe(canal, externalId), delay }
    );
    console.log(
      `[recontacto] Programado paso ${paso}/${MAX_PASOS} para ${canal}:${externalId} en ${Math.round(delay / 60000)} min.`
    );
  } catch (err) {
    console.error(`[recontacto] No pude programar el paso ${paso} de ${canal}:${externalId}:`, err);
  }
}
