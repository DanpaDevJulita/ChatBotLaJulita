import { Worker } from "bullmq";
import { getRedisConnection } from "../core/queue/redis.js";
import { QUEUE_RECORDATORIO_VISITA, type RecordatorioVisitaJob } from "../core/queue/recordatorioQueue.js";
import { ejecutarRecordatorioVisita } from "../core/pipeline/recordatorioVisita.js";

/**
 * [2026-09-14] Consume la cola `recordatorio-visita`: un solo trabajo por reserva, programado
 * para el día antes del check-in (ver recordatorioQueue.ts). Mismo patrón que bloqueoWorker.ts y
 * recontactoWorker.ts, corre en el mismo proceso `npm run worker`.
 */
export function startRecordatorioWorker() {
  const worker = new Worker<RecordatorioVisitaJob>(
    QUEUE_RECORDATORIO_VISITA,
    async (job) => {
      await ejecutarRecordatorioVisita(job.data);
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[recordatorioWorker] Falló el trabajo ${job?.id} (canal=${job?.data?.canal}, ` +
        `external_id=${job?.data?.externalId}, reservaId=${job?.data?.reservaId}):`,
      err
    );
  });

  return worker;
}
