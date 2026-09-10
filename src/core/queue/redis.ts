import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.warn("Falta REDIS_URL en tu .env — la cola de mensajes entrantes no va a funcionar.");
}

let connection: Redis | null = null;

/**
 * Conexión compartida a Redis, reusada tanto por el productor (server.ts, al recibir el
 * webhook de WhatsApp) como por el worker (worker/start.ts, al procesar cada mensaje) —
 * mismo patrón que src/lib/redis.ts en agente-ycloud-main.
 *
 * maxRetriesPerRequest: null es un requisito de BullMQ (no una preferencia nuestra): un
 * Worker usa comandos bloqueantes de Redis para esperar trabajos nuevos, y el límite de
 * reintentos por defecto de ioredis rompe ese bloqueo — ver la documentación de BullMQ.
 */
export function getRedisConnection(): Redis {
  if (connection) return connection;
  connection = new Redis(REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
  connection.on("error", (err) => {
    console.error("[redis] Error de conexión:", err.message);
  });
  return connection;
}
