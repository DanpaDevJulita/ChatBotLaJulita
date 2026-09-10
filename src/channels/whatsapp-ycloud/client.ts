import axios, { AxiosError, AxiosInstance } from "axios";

/**
 * Cliente de bajo nivel para la API de YCloud — portado de
 * agente-ycloud-main/src/services/ycloudClient.ts, simplificado (por ahora solo texto e
 * imagen; documentos y descarga de media se agregan cuando los necesitemos).
 */

const YCLOUD_API_KEY = process.env.YCLOUD_API_KEY ?? "";
const YCLOUD_FROM_PHONE_NUMBER = process.env.YCLOUD_FROM_PHONE_NUMBER ?? "";
const YCLOUD_BASE_URL = process.env.YCLOUD_BASE_URL ?? "https://api.ycloud.com";
const YCLOUD_DRY_RUN = process.env.YCLOUD_DRY_RUN === "true";

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (!client) {
    client = axios.create({
      baseURL: YCLOUD_BASE_URL,
      timeout: 30_000,
      headers: { "X-API-Key": YCLOUD_API_KEY, "Content-Type": "application/json" },
    });
  }
  return client;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, op: string, maxAttempts = 4): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      const retriable = status === 429 || (status !== undefined && status >= 500 && status < 600);
      if (!retriable || attempt >= maxAttempts) {
        console.error(`[ycloud] ${op} falló`, status, ax.response?.data);
        throw err;
      }
      const wait = 2 ** attempt * 500;
      console.warn(`[ycloud] ${op} reintento ${attempt} (status ${status}) en ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * [2026-09-08] Un mensaje de texto de WhatsApp NO puede pasar los 4.096 caracteres. Si se
 * manda más largo, YCloud igual acepta la petición (el bot cree que respondió, no hay error
 * en la consola) pero el cliente no recibe NADA — así se perdían justo las respuestas de
 * precios, que eran las más largas (16.319 caracteres medidos en la auditoría). Partimos en
 * 3.900 para dejar margen, cortando en el último borde limpio: párrafo, si no línea, si no
 * espacio.
 */
const MAX_WHATSAPP_CHARS = 3900;

function partirTexto(texto: string, limite = MAX_WHATSAPP_CHARS): string[] {
  if (texto.length <= limite) return [texto];
  const partes: string[] = [];
  let resto = texto;
  while (resto.length > limite) {
    const ventana = resto.slice(0, limite);
    let corte = Math.max(ventana.lastIndexOf("\n\n"), ventana.lastIndexOf("\n"));
    if (corte < limite * 0.5) corte = ventana.lastIndexOf(" ");
    if (corte <= 0) corte = limite;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto.length > 0) partes.push(resto);
  return partes;
}

/** `target`: teléfono E.164 ("+573...") — usuarios @ de WhatsApp se agregan más adelante si hace falta. */
export async function sendTextMessage(target: string, text: string): Promise<{ id?: string }> {
  const partes = partirTexto(text);
  if (partes.length > 1) {
    console.warn(
      `[ycloud] El mensaje para ${target} mide ${text.length} caracteres (WhatsApp corta en 4096): se manda en ${partes.length} partes.`
    );
  }
  let ultima: { id?: string } = {};
  for (const parte of partes) {
    ultima = await enviarUnTexto(target, parte);
  }
  return ultima;
}

async function enviarUnTexto(target: string, text: string): Promise<{ id?: string }> {
  if (YCLOUD_DRY_RUN) {
    console.log(`[ycloud dry-run] a ${target}: ${text.slice(0, 80)}`);
    return { id: `dry-run-${Date.now()}` };
  }
  const body = { from: YCLOUD_FROM_PHONE_NUMBER, to: target, type: "text", text: { body: text } };
  const res = await withRetry(() => getClient().post("/v2/whatsapp/messages", body), "sendText");
  return res.data ?? {};
}

export async function sendImageMessage(target: string, imageUrl: string, caption?: string): Promise<{ id?: string }> {
  if (YCLOUD_DRY_RUN) {
    console.log(`[ycloud dry-run] imagen a ${target}: ${imageUrl}`);
    return { id: `dry-run-img-${Date.now()}` };
  }
  const body = {
    from: YCLOUD_FROM_PHONE_NUMBER,
    to: target,
    type: "image",
    image: { link: imageUrl, ...(caption ? { caption } : {}) },
  };
  const res = await withRetry(() => getClient().post("/v2/whatsapp/messages", body), "sendImage");
  return res.data ?? {};
}
