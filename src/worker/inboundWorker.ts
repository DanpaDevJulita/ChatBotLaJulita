import { Worker } from "bullmq";
import { getRedisConnection } from "../core/queue/redis.js";
import { QUEUE_INBOUND } from "../core/queue/inboundQueue.js";
import { handleInbound } from "../core/pipeline/runTurn.js";
import { getChannel } from "../channels/registry.js";
import type { InboundEvent } from "../channels/types.js";

/**
 * Consume la cola `inbound`: por cada trabajo, busca el adaptador del canal correspondiente
 * (hoy solo "whatsapp" está registrado, ver worker/start.ts) y llama a handleInbound —
 * exactamente la misma función que antes se llamaba directo desde server.ts, solo que ahora
 * corre en este proceso separado (`npm run worker`), no en el que recibe el webhook.
 *
 * concurrency: 5 → hasta 5 conversaciones distintas se procesan en paralelo. Si dos mensajes
 * del MISMO cliente llegan casi al tiempo, BullMQ no garantiza el orden entre trabajos
 * distintos — no es un problema hoy (cada trabajo es independiente) pero es la razón por la
 * que agente-ycloud-main usa jobId por contacto para evitar carreras (ver nota en
 * inboundQueue.ts).
 */
export function startInboundWorker() {
  const worker = new Worker<InboundEvent>(
    QUEUE_INBOUND,
    async (job) => {
      const event = job.data;
      const adapter = getChannel(event.channel);
      await handleInbound(event, adapter);
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[inboundWorker] Falló el trabajo ${job?.id} (canal=${job?.data?.channel}, external_id=${job?.data?.externalId}):`,
      err
    );
  });

  return worker;
}
