import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";
import type { InboundEvent } from "../../channels/types.js";

export const QUEUE_INBOUND = "inbound";

let queue: Queue<InboundEvent> | null = null;

/**
 * Cola de mensajes entrantes — mismo propósito que src/queues/inbound.ts en agente-ycloud-main:
 * el webhook de WhatsApp (server.ts) solo empuja el evento aquí y responde 200 de inmediato;
 * un proceso worker SEPARADO (src/worker/start.ts, se arranca con `npm run worker`) es quien
 * de verdad llama a handleInbound. Así, si el bot tarda en responder o el worker se cae un
 * momento, el mensaje del cliente no se pierde — queda esperando en Redis hasta que el worker
 * vuelva a estar disponible, y BullMQ reintenta automáticamente si algo falla a mitad de camino.
 *
 * [PENDIENTE — simplificado a propósito, primera versión] agente-ycloud-main además agrupa
 * varios mensajes seguidos del mismo cliente en un solo turno (debounce + buffer en Redis, ver
 * su queues/inbound.ts) — acá cada mensaje entra como un trabajo independiente, más simple de
 * entender/depurar mientras se prueba esta primera versión de la cola. Se puede agregar ese
 * agrupamiento después si notan que el bot responde "a destiempo" cuando el cliente escribe
 * varios mensajes seguidos muy rápido.
 */
export function getInboundQueue(): Queue<InboundEvent> {
  if (!queue) {
    queue = new Queue<InboundEvent>(QUEUE_INBOUND, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        // Limpieza automática: no acumular para siempre trabajos ya completados/fallidos.
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
}

export async function enqueueInbound(event: InboundEvent): Promise<void> {
  const q = getInboundQueue();
  await q.add("process", event);
}
