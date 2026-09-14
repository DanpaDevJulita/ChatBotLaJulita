import { Worker } from "bullmq";
import { getRedisConnection } from "../core/queue/redis.js";
import { QUEUE_BLOQUEO, type BloqueoJob } from "../core/queue/bloqueoQueue.js";
import { ejecutarLiberacionBloqueo } from "../core/pipeline/bloqueo.js";
import { ejecutarChequeoTemprano } from "../core/pipeline/chequeoTemprano.js";
import { getChannel } from "../channels/registry.js";

/**
 * Consume la cola `bloqueo`: hoy tiene DOS tipos de trabajo, distinguidos por `job.name`:
 *   - "liberar" — la liberación automática de un cupo que un cliente tenía apartado (ver
 *     src/agentes/ventas/herramientas/reserva.ts) y no confirmó a tiempo.
 *   - "chequeo-temprano" — [2026-09-13] una consulta a Bold DE PASO, mientras el bloqueo sigue
 *     vigente (a los 3 y 7 minutos por defecto — ver MINUTOS_CHEQUEO_TEMPRANO), para no depender
 *     solo del webhook de Bold o de que el cliente escriba.
 * Mismo patrón que recontactoWorker.ts, corre en el mismo proceso `npm run worker`.
 */
export function startBloqueoWorker() {
  const worker = new Worker<BloqueoJob>(
    QUEUE_BLOQUEO,
    async (job) => {
      if (job.name === "chequeo-temprano") {
        // El id del job es "bloqueo-<id>-chequeo-<minuto>" (ver jobIdChequeo): de ahí sale qué
        // chequeo es este, para que al terminar no intente cancelarse a sí mismo — BullMQ lo
        // tiene tomado mientras corre y eso dejaba un "could not be removed because it is locked
        // by another worker" en los logs que parecía un error y no lo era.
        const minutoEnCurso = Number(String(job.id ?? "").match(/-chequeo-(\d+)$/)?.[1]) || undefined;
        await ejecutarChequeoTemprano(job.data, minutoEnCurso);
        return;
      }
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
