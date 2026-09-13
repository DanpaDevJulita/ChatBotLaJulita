import { Worker } from "bullmq";
import { getRedisConnection } from "../core/queue/redis.js";
import { QUEUE_INBOUND } from "../core/queue/inboundQueue.js";
import { enTurnoPorConversacion } from "../core/queue/enTurno.js";
import { handleInbound } from "../core/pipeline/runTurn.js";
import { getChannel } from "../channels/registry.js";
import type { InboundEvent } from "../channels/types.js";

/**
 * Consume la cola `inbound`: por cada trabajo, busca el adaptador del canal correspondiente
 * (hoy solo "whatsapp" está registrado, ver worker/start.ts) y llama a handleInbound —
 * exactamente la misma función que antes se llamaba directo desde server.ts, solo que ahora
 * corre en este proceso separado (`npm run worker`), no en el que recibe el webhook.
 *
 * concurrency: 5 → hasta 5 conversaciones distintas se procesan en paralelo.
 *
 * [2026-09-11] Los mensajes del MISMO cliente, en cambio, se procesan de a UNO, en fila (ver
 * core/queue/enTurno.ts). Antes no era así y costó caro: un cliente mandó nombre, cédula y
 * celular en tres mensajes casi simultáneos, dos se procesaron en paralelo, y terminó con DOS
 * reservas creadas y DOS links de pago distintos por la misma estadía. El turno lee y escribe
 * historial y base de datos, así que dos turnos de la misma conversación al tiempo es una
 * carrera: la fila por conversación lo cierra sin frenar a los demás clientes.
 */
export function startInboundWorker() {
  const worker = new Worker<InboundEvent>(
    QUEUE_INBOUND,
    async (job) => {
      const event = job.data;
      const adapter = getChannel(event.channel);
      // La clave es la conversación: mismo canal + mismo cliente = misma fila.
      await enTurnoPorConversacion(`${event.channel}:${event.externalId}`, () => handleInbound(event, adapter));
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
