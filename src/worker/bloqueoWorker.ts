import { Worker } from "bullmq";
import { getRedisConnection } from "../core/queue/redis.js";
import { QUEUE_BLOQUEO, type BloqueoJob } from "../core/queue/bloqueoQueue.js";
import { ejecutarLiberacionBloqueo } from "../core/pipeline/bloqueo.js";
import { getChannel } from "../channels/registry.js";

/**
 * Consume la cola `bloqueo`: cada trabajo es la liberación automática de un cupo que un
 * cliente tenía apartado (ver src/agentes/ventas/herramientas/reserva.ts) y no confirmó a tiempo. Mismo patrón
 * que recontactoWorker.ts, corre en el mismo proceso `npm run worker`.
 */
export function startBloqueoWorker() {
  const worker = new Worker<BloqueoJob>(
    QUEUE_BLOQUEO,
    async (job) => {
      const adapter = getChannel(job.data.canal);
      await ejecutarLiberacionBloqueo(job.data, adapter);
    },
    { connection: getRedisConnection(), concurrency: 2 }
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[bloqueoWorker] Falló el trabajo ${job?.id} (canal=${job?.data?.canal}, external_id=${job?.data?.externalId}, bloqueoId=${job?.data?.bloqueoId}):`,
      err
    );
  });

  return worker;
}
