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
const YCLOUD_CATALOG_ID = process.env.YCLOUD_CATALOG_ID ?? "";

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
  // [2026-09-16] `preview_url: true` es lo que le pide a WhatsApp que genere la tarjeta de
  // vista previa (imagen, título) cuando el texto trae un link — por ejemplo el video de
  // YouTube de un plan. Sin este flag, la API de WhatsApp Business (a diferencia de WhatsApp
  // normal entre personas) manda el link como texto plano, sin preview. Lo notó Daniel en
  // pruebas reales: el link del video salía en verde/subrayado pero sin la miniatura.
  const body = {
    from: YCLOUD_FROM_PHONE_NUMBER,
    to: target,
    type: "text",
    text: { body: text, preview_url: true },
  };
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

/**
 * [2026-09-16] Video NATIVO de WhatsApp (type: "video"), no un link en un mensaje de texto.
 * `videoUrl` tiene que ser la URL directa a un archivo .mp4 (o .3gp) público — WhatsApp la
 * descarga él mismo — NO la página de YouTube: WhatsApp no reproduce videos de otras
 * plataformas adentro de la app, solo archivos de video de verdad. Con esto el cliente ve la
 * miniatura al toque y reproduce sin salir de WhatsApp. Límite de WhatsApp: 16 MB por video.
 */
export async function sendVideoMessage(target: string, videoUrl: string, caption?: string): Promise<{ id?: string }> {
  if (YCLOUD_DRY_RUN) {
    console.log(`[ycloud dry-run] video a ${target}: ${videoUrl}`);
    return { id: `dry-run-video-${Date.now()}` };
  }
  const body = {
    from: YCLOUD_FROM_PHONE_NUMBER,
    to: target,
    type: "video",
    video: { link: videoUrl, ...(caption ? { caption } : {}) },
  };
  const res = await withRetry(() => getClient().post("/v2/whatsapp/messages", body), "sendVideo");
  return res.data ?? {};
}

export interface MediaDescargado {
  buffer: Buffer;
  mime: string;
}

/**
 * Descarga los bytes de un media entrante (nota de voz, imagen...) — portado de downloadMedia()
 * en agente-ycloud-main/src/services/ycloudClient.ts. YCloud entrega, en el propio webhook, un
 * link de descarga PRE-FIRMADO (con `sig` + `payload`); se usa ESE link directo. El path
 * genérico `/v2/whatsapp/media/{id}` devuelve 404 en la práctica, así que el mediaId solo se
 * intenta como último recurso si no vino ningún link.
 */
export async function descargarMedia(ref: { link?: string; mediaId?: string }): Promise<MediaDescargado> {
  const target = ref.link ?? `/v2/whatsapp/media/${encodeURIComponent(ref.mediaId ?? "")}`;
  if (!ref.link) {
    console.warn(`[ycloud] descargando media sin link firmado (mediaId=${ref.mediaId}) — puede fallar con 404`);
  }
  const res = await withRetry(
    () => getClient().get<ArrayBuffer>(target, { responseType: "arraybuffer" }),
    "descargarMedia"
  );
  const mime = (res.headers?.["content-type"] as string) ?? "application/octet-stream";
  return { buffer: Buffer.from(res.data), mime };
}

/**
 * [2026-09-15] Carousel template — usado SOLO para el módulo de promociones (ver
 * src/core/marketing/promocionesBroadcast.ts y REFERENCIA-CAROUSEL-WHATSAPP.md). A diferencia
 * de sendText/sendImage/sendVideo, esto NO es un mensaje libre: `templateName` tiene que ser el
 * nombre EXACTO de una plantilla ya aprobada por Meta (registrada en la tabla
 * `plantillas_carousel`), con el mismo número de tarjetas que trae `tarjetas` — si no calzan,
 * YCloud rechaza el envío completo (por eso quien llama valida el conteo ANTES de invocar esto,
 * ver promocionesBroadcast.ts).
 *
 * `precioTexto` solo aplica si la plantilla aprobada usa una variable `{{1}}` en el body de la
 * tarjeta (recomendado para promociones, porque el precio/oferta cambia seguido y así no hay
 * que re-aprobar la plantilla cada vez). `urlVariable` solo aplica si la plantilla trae un botón
 * de tipo URL con variable — ver la nota de la sección 5 de REFERENCIA-CAROUSEL-WHATSAPP.md.
 */
export interface TarjetaCarousel {
  imagenUrl: string;
  precioTexto?: string;
  urlVariable?: string;
  /** Payload que WhatsApp devuelve en el webhook si el cliente toca el botón de respuesta
   *  rápida de esta tarjeta (por ejemplo "promo_12") — no lo ve el cliente. */
  quickReplyPayload?: string;
}

export async function sendCarouselTemplate(
  target: string,
  templateName: string,
  tarjetas: TarjetaCarousel[],
  idioma = "es"
): Promise<{ id?: string }> {
  if (YCLOUD_DRY_RUN) {
    console.log(`[ycloud dry-run] carousel "${templateName}" a ${target}: ${tarjetas.length} tarjeta(s)`);
    return { id: `dry-run-carousel-${Date.now()}` };
  }

  const cards = tarjetas.map((t, i) => {
    const components: Record<string, unknown>[] = [
      { type: "header", parameters: [{ type: "image", image: { link: t.imagenUrl } }] },
    ];
    if (t.precioTexto) {
      components.push({ type: "body", parameters: [{ type: "text", text: t.precioTexto }] });
    }
    if (t.quickReplyPayload) {
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: 0,
        parameters: [{ type: "payload", payload: t.quickReplyPayload }],
      });
    }
    if (t.urlVariable) {
      components.push({
        type: "button",
        sub_type: "url",
        index: 1,
        parameters: [{ type: "text", text: t.urlVariable }],
      });
    }
    return { card_index: i, components };
  });

  const body = {
    from: YCLOUD_FROM_PHONE_NUMBER,
    to: target,
    type: "template",
    template: {
      name: templateName,
      language: { code: idioma, policy: "deterministic" },
      components: [{ type: "carousel", cards }],
    },
  };
  const res = await withRetry(() => getClient().post("/v2/whatsapp/messages", body), "sendCarouselTemplate");
  return res.data ?? {};
}

/**
 * [2026-09-15] Mensaje de CATÁLOGO (`interactive.type: "product_list"`) — la alternativa
 * GRATIS al carrusel de pago: es un mensaje normal (no una plantilla), así que no cuesta nada
 * mandarlo dentro de una conversación abierta, pero a cambio exige que los planes existan como
 * "productos" en un catálogo de Meta conectado a este WhatsApp Business Account — ver
 * REFERENCIA-CATALOGO-WHATSAPP.md para el paso a paso de esa parte (100% manual, en Meta
 * Commerce Manager, el código no puede crearlo solo).
 *
 * `secciones` agrupa los productos que se muestran (ej. una sección "Planes recomendados") —
 * cada `retailerId` tiene que ser EXACTAMENTE el SKU con el que se cargó ese plan en el
 * catálogo (columna `planes.retailer_id`, ver sql/planes-retailer-id.sql).
 */
export interface SeccionCatalogo {
  titulo: string;
  retailerIds: string[];
}

export async function sendMultiProductMessage(
  target: string,
  body: string,
  secciones: SeccionCatalogo[],
  opciones?: { header?: string; footer?: string; catalogId?: string }
): Promise<{ id?: string }> {
  const catalogId = opciones?.catalogId || YCLOUD_CATALOG_ID;
  if (!catalogId) {
    throw new Error(
      "Falta configurar YCLOUD_CATALOG_ID (.env) — sin eso no se puede mandar el mensaje de catálogo."
    );
  }
  if (YCLOUD_DRY_RUN) {
    const total = secciones.reduce((n, s) => n + s.retailerIds.length, 0);
    console.log(`[ycloud dry-run] catálogo a ${target}: ${secciones.length} sección(es), ${total} producto(s)`);
    return { id: `dry-run-catalogo-${Date.now()}` };
  }

  const body_ = {
    from: YCLOUD_FROM_PHONE_NUMBER,
    to: target,
    type: "interactive",
    interactive: {
      type: "product_list",
      ...(opciones?.header ? { header: { type: "text", text: opciones.header } } : {}),
      body: { text: body },
      ...(opciones?.footer ? { footer: { text: opciones.footer } } : {}),
      action: {
        catalog_id: catalogId,
        sections: secciones.map((s) => ({
          title: s.titulo,
          product_items: s.retailerIds.map((id) => ({ product_retailer_id: id })),
        })),
      },
    },
  };
  const res = await withRetry(() => getClient().post("/v2/whatsapp/messages", body_), "sendMultiProductMessage");
  return res.data ?? {};
}
