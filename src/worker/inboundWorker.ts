import { Worker } from "bullmq";
import { getRedisConnection } from "../core/queue/redis.js";
import { QUEUE_INBOUND, drainInboundBuffer, combinarEventosDelBuffer } from "../core/queue/inboundQueue.js";
import { enTurnoPorConversacion } from "../core/queue/enTurno.js";
import { handleInbound } from "../core/pipeline/runTurn.js";
import { getChannel } from "../channels/registry.js";

/**
 * Consume la cola `inbound`: por cada trabajo, busca el adaptador del canal correspondiente
 * (hoy solo "whatsapp" está registrado, ver worker/start.ts) y llama a handleInbound —
 * exactamente la misma función que antes se llamaba directo desde server.ts, solo que ahora
 * corre en este proceso separado (`npm run worker`), no en el que recibe el webhook.
 *
 * concurrency: 5 → hasta 5 conversaciones distintas se procesan en paralelo.
 *
 * [2026-09-14] El trabajo YA NO trae el mensaje: solo trae DE QUÉ CONVERSACIÓN es (ver
 * InboundJobData en inboundQueue.ts). Eso es a propósito — el trabajo se reagenda con debounce
 * cada vez que llega un mensaje nuevo de esa misma conversación (ver enqueueInbound), así que
 * cuando por fin corre, lo primero que hace es vaciar el BUFFER de esa conversación
 * (drainInboundBuffer) para agarrar TODO lo que se acumuló mientras esperaba, no solo el último
 * mensaje. `combinarEventosDelBuffer` los junta en un solo turno cuando son puros mensajes de
 * texto (el caso típico: cliente escribiendo datos en mensajes sueltos) — ver ese comentario en
 * inboundQueue.ts para el porqué completo y el caso real que lo motivó.
 *
 * Si el buffer llega vacío (pudo pasar por la carrera del trabajo "independiente" que menciona
 * enqueueInbound cuando el trabajo anterior estaba activo) simplemente no hay nada que hacer:
 * no es un error, otro trabajo ya lo procesó.
 *
 * [2026-09-11] Los mensajes del MISMO cliente, en cambio, se procesan de a UNO, en fila (ver
 * core/queue/enTurno.ts). Antes no era así y costó caro: un cliente mandó nombre, cédula y
 * celular en tres mensajes casi simultáneos, dos se procesaron en paralelo, y terminó con DOS
 * reservas creadas y DOS links de pago distintos por la misma estadía. El turno lee y escribe
 * historial y base de datos, así que dos turnos de la misma conversación al tiempo es una
 * carrera: la fila por conversación lo cierra sin frenar a los demás clientes. El debounce de
 * arriba reduce cuántas veces se dispara esa fila; esta fila sigue estando para lo que el
 * debounce no alcance a agrupar (ej. el mensaje "independiente" de la carrera de arriba).
 */
export function startInboundWorker() {
  const worker = new Worker<{ channel: string; externalId: string }>(
    QUEUE_INBOUND,
    async (job) => {
      const { channel, externalId } = job.data;
      const eventos = await drainInboundBuffer(channel, externalId);
      if (eventos.length === 0) {
        // El buffer ya estaba vacío — otro trabajo (el de la carrera con jobId independiente,
        // ver enqueueInbound) ya lo procesó. No hay nada más que hacer acá.
        return;
      }

      const adapter = getChannel(channel);
      const paraProcesar = combinarEventosDelBuffer(eventos);

      // La clave es la conversación: mismo canal + mismo cliente = misma fila. Si
      // combinarEventosDelBuffer no pudo juntar todo en uno (media mezclado con texto),
      // `paraProcesar` trae varios eventos: se procesan en orden, DENTRO de la misma fila, para
      // no repetir la carrera de reservas duplicadas que motivó enTurnoPorConversacion.
      await enTurnoPorConversacion(`${channel}:${externalId}`, async () => {
        for (const evento of paraProcesar) {
          await handleInbound(evento, adapter);
        }
      });
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
