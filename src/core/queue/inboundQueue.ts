import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";
import type { InboundEvent } from "../../channels/types.js";

export const QUEUE_INBOUND = "inbound";

/**
 * [2026-09-14] Debounce + buffer de mensajes seguidos del mismo cliente — mismo mecanismo que
 * agente-ycloud-main (src/queues/inbound.ts, "Sebas Raider"), portado acá a pedido de Daniel.
 *
 * Historia: cada mensaje entraba como un trabajo INDEPENDIENTE (ver el comentario que estaba
 * acá abajo hasta hoy). Si el cliente mandaba varios mensajes seguidos y separados —típico
 * cuando escribe datos a mano, ej. "CC80419360", luego "cc52841275", luego "45", luego "50"—
 * el bot procesaba y CONTESTABA cada uno por separado: alcanzaba a "confirmar la reserva" con
 * el primer documento antes de que llegara el segundo, o repetía la misma pregunta dos veces
 * porque cada mensaje era, para el pipeline, una conversación que arrancaba de cero en ese
 * instante. Daniel lo vio en vivo el 14/09: el bot le preguntó "¿el CC 80419360 es de Marcela o
 * de Efraín? Y falta la edad" DOS VECES seguidas, una por cada mensaje de documento que mandó
 * por separado, en vez de esperar a que terminara de mandar los cuatro.
 *
 * Ahora: cada InboundEvent se ACUMULA en una lista de Redis por conversación
 * (`inbound:buffer:<canal>:<externalId>`, ver bufferKey) y se agenda un trabajo de BullMQ CON
 * DELAY (DEBOUNCE_MS) en vez de procesarse ya mismo. Si llega OTRO mensaje de la MISMA
 * conversación antes de que se cumpla ese plazo, se agrega a la lista Y el trabajo pendiente se
 * reinicia desde cero (mismo jobId ⇒ mismo trabajo: se borra el que estaba esperando y se agenda
 * uno nuevo con el delay completo otra vez). Solo cuando pasan DEBOUNCE_MS SIN mensajes nuevos de
 * esa conversación, el worker recibe el trabajo, vacía el buffer completo (ver
 * drainInboundBuffer) y procesa todo junto como un solo turno (ver combinarEventosDelBuffer, acá
 * abajo, y worker/inboundWorker.ts, que es quien la usa).
 *
 * Por qué un delay de BullMQ (Redis) y no un simple setTimeout en memoria: sobrevive un reinicio
 * del proceso worker a mitad de la espera (el mensaje no se pierde) y sigue sirviendo igual si
 * algún día corre más de un proceso worker en paralelo — un setTimeout en memoria de un proceso
 * no lo sabría el otro.
 */
export const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS) || 20_000;

/**
 * Lo mínimo que necesita el trabajo de BullMQ: SOLO la identidad de la conversación — los
 * mensajes de verdad viven en la lista de Redis del buffer (ver bufferKey), no en el trabajo.
 * Así, si llegan 4 mensajes seguidos, no se crean 4 trabajos con 4 copias del evento: se
 * reescribe el mismo trabajo (mismo jobId) una y otra vez, y cuando por fin corre, va a buscar
 * TODO lo acumulado directo del buffer.
 */
interface InboundJobData {
  channel: string;
  externalId: string;
}

let queue: Queue<InboundJobData> | null = null;

export function getInboundQueue(): Queue<InboundJobData> {
  if (!queue) {
    queue = new Queue<InboundJobData>(QUEUE_INBOUND, {
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

function bufferKey(channel: string, externalId: string): string {
  return `inbound:buffer:${channel}:${externalId}`;
}

/**
 * BullMQ prohíbe ":" en un jobId personalizado (lo usa internamente como separador de sus
 * propias keys en Redis) — con ":" acá, CADA intento de (re)agendar el trabajo fallaba con
 * "Custom Id cannot contain :" y el debounce nunca llegaba a agendar nada (se detectó recién al
 * correr la prueba de este mecanismo contra Redis de verdad, ver e2e-debounce-mensajes.ts). Se
 * usa "|" como separador en su lugar — no es un caracter válido de canal ni de externalId.
 */
function jobIdDe(channel: string, externalId: string): string {
  return `inbound-${channel}|${externalId}`;
}

/**
 * [2026-09-17] Cuánto se recuerda el id de un mensaje ya procesado. 24 horas es de sobra: un
 * proveedor que reintenta lo hace en minutos, no al día siguiente. Y aunque se le pase el plazo a
 * un reintento rarísimo, lo peor que pasa es volver al comportamiento de antes (contestar dos
 * veces), no perder un mensaje.
 */
const TTL_ID_VISTO_S = 24 * 60 * 60;

function idVistoKey(channel: string, messageId: string): string {
  return `inbound:visto:${channel}:${messageId}`;
}

/**
 * [2026-09-17] ¿Este mensaje ya lo recibimos antes? Descarta una entrega REPETIDA del webhook.
 *
 * El caso real: el 2026-09-17, un cliente escribió "Voy con mi novia" y "De aniversario". El
 * debounce los agrupó bien y el bot contestó a las 15:46. A las 15:51:56 YCloud volvió a entregar
 * "Voy con mi novia" —un reintento, porque el bot corre detrás de un túnel de Cloudflare y basta
 * un tropezón de red para que no le llegue el 200 a tiempo— y el bot lo tomó por un mensaje nuevo
 * y contestó lo mismo otra vez. En el WhatsApp del cliente solo se ven sus dos mensajes: la app
 * descarta el duplicado por id, nosotros no lo mirábamos.
 *
 * El debounce no cubre esto: agrupa lo que llega dentro de DEBOUNCE_MS (20 s), y un reintento
 * puede tardar minutos. Son dos problemas distintos y cada uno necesita su propia defensa.
 *
 * FALLA ABIERTO a propósito: si Redis no responde, o el canal no manda un id, se procesa el
 * mensaje igual. Contestar dos veces es molesto; tragarse el mensaje de un cliente es peor.
 */
async function yaProcesado(event: InboundEvent): Promise<boolean> {
  if (!event.messageId) return false;
  try {
    const redis = getRedisConnection();
    // SET ... NX es atómico: el primero en llegar lo crea, cualquier otro recibe null. Así, si
    // dos entregas del mismo mensaje caen a la vez, solo una sigue adelante.
    const creado = await redis.set(idVistoKey(event.channel, event.messageId), "1", "EX", TTL_ID_VISTO_S, "NX");
    return creado === null;
  } catch (err) {
    console.error("[inboundQueue] no pude revisar si el mensaje ya llegó antes (sigo igual):", err);
    return false;
  }
}

/**
 * Encola un evento entrante con debounce: lo agrega al buffer de Redis de su conversación y
 * (re)agenda el trabajo que la va a procesar dentro de DEBOUNCE_MS si no llega nada más antes.
 * Ver el comentario grande de arriba para el porqué completo.
 */
export async function enqueueInbound(event: InboundEvent): Promise<void> {
  // Antes que nada: si es una entrega repetida del mismo mensaje, no entra ni al buffer. Si
  // entrara, el debounce lo juntaría con lo que venga después y el cliente vería su frase
  // duplicada dentro del turno siguiente.
  if (await yaProcesado(event)) {
    console.log(
      `[inboundQueue] ${event.channel}:${event.externalId}: entrega repetida del mensaje ` +
        `${event.messageId} — la descarto (ya se procesó).`
    );
    return;
  }

  const q = getInboundQueue();
  const redis = getRedisConnection();
  // Nunca se descarta un mensaje: primero se guarda en el buffer, pase lo que pase después con
  // el trabajo de BullMQ.
  await redis.rpush(bufferKey(event.channel, event.externalId), JSON.stringify(event));

  const jobId = jobIdDe(event.channel, event.externalId);
  const jobData: InboundJobData = { channel: event.channel, externalId: event.externalId };

  const existente = await q.getJob(jobId);
  if (existente) {
    try {
      // Reinicia el plazo desde cero: se borra el trabajo que estaba esperando y se agenda uno
      // nuevo más abajo, con el delay completo otra vez.
      await existente.remove();
    } catch {
      // No se pudo borrar: significa que el worker lo tiene ACTIVO ahora mismo (lo está
      // procesando en este instante — BullMQ no deja borrar un trabajo activo). Ese jobId ya no
      // se puede reusar. Se agenda un trabajo INDEPENDIENTE (sin jobId fijo) con su propio
      // delay para no perder este mensaje — cuando le toque correr, va a encontrar el buffer
      // como haya quedado (vacío si el trabajo activo ya lo vació, o con lo que se acumuló
      // mientras tanto), según cómo caiga la carrera. Es la misma solución que usa
      // agente-ycloud-main para el mismo caso.
      await q.add("process", jobData, { delay: DEBOUNCE_MS });
      return;
    }
  }

  try {
    await q.add("process", jobData, { jobId, delay: DEBOUNCE_MS });
  } catch (err) {
    // Carrera muy poco probable: otro enqueueInbound concurrente de la MISMA conversación ya
    // volvió a crear ese jobId entre el remove() de arriba y este add(). El mensaje de este
    // evento ya quedó en el buffer (el rpush de arriba corrió igual), así que no se pierde —
    // ese otro trabajo lo recoge cuando drene el buffer.
    console.warn(`[inboundQueue] no se pudo (re)agendar el trabajo ${jobId} (probable carrera):`, err);
  }
}

/**
 * Vacía ATÓMICAMENTE el buffer de una conversación (LRANGE + DEL en la misma transacción de
 * Redis, para que ningún mensaje quede a mitad de camino) y devuelve los eventos acumulados en
 * el mismo orden en que llegaron (rpush siempre agrega al final).
 */
export async function drainInboundBuffer(channel: string, externalId: string): Promise<InboundEvent[]> {
  const redis = getRedisConnection();
  const key = bufferKey(channel, externalId);
  const resultados = await redis.multi().lrange(key, 0, -1).del(key).exec();
  const crudos = (resultados?.[0]?.[1] as string[] | undefined) ?? [];
  return crudos.map((r) => JSON.parse(r) as InboundEvent);
}

/**
 * Junta los eventos acumulados de una racha en UNO solo, para que el bot los trate como un
 * único turno de conversación (una sola pasada por el orquestador + el agente, una sola
 * respuesta) en vez de contestar cada mensaje por separado — el caso exacto que reportó Daniel
 * el 14/09 (documento, cédula y edad en mensajes sueltos).
 *
 * Si en la racha hay algún mensaje con media (audio/imagen) mezclado con texto, se devuelven
 * los eventos SIN combinar, para procesarlos uno por uno en su orden original (igual que antes
 * de este cambio): todavía no está definido cómo "juntar" un audio con texto suelto en un solo
 * turno, y no vale la pena inventarlo para un caso que hoy es raro.
 */
export function combinarEventosDelBuffer(eventos: InboundEvent[]): InboundEvent[] {
  if (eventos.length <= 1) return eventos;

  const todosTexto = eventos.every((e) => !e.mediaType && typeof e.text === "string");
  if (!todosTexto) return eventos;

  const textos = eventos.map((e) => (e.text ?? "").trim()).filter((t) => t.length > 0);
  if (textos.length === 0) return eventos;

  const ultimo = eventos[eventos.length - 1];
  return [
    {
      channel: ultimo.channel,
      externalId: ultimo.externalId,
      text: textos.join("\n"),
      timestamp: ultimo.timestamp,
      raw: eventos.map((e) => e.raw),
    },
  ];
}
