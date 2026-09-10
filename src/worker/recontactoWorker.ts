import { Worker } from "bullmq";
import { getRedisConnection } from "../core/queue/redis.js";
import { QUEUE_RECONTACTO, type RecontactoJob } from "../core/queue/recontactoQueue.js";
import { ejecutarRecontacto } from "../core/pipeline/recontacto.js";
import { getChannel } from "../channels/registry.js";

/**
 * Consume la cola `recontacto`: cada trabajo es un recordatorio programado para una
 * conversación que se quedó callada. Corre en el mismo proceso worker que la cola `inbound`
 * (`npm run worker`), con concurrencia baja porque no hay ninguna prisa.
 */
export function startRecontactoWorker() {
  const worker = new Worker<RecontactoJob>(
    QUEUE_RECONTACTO,
    async (job) => {
      const adapter = getChannel(job.data.canal);
      await ejecutarRecontacto(job.data, adapter);
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[recontactoWorker] Falló el trabajo ${job?.id} (canal=${job?.data?.canal}, external_id=${job?.data?.externalId}, paso=${job?.data?.paso}):`,
      err
    );
  });

  return worker;
}
