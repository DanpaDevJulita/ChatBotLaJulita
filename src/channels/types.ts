/**
 * Contrato común entre el bot (src/core) y cualquier canal (WhatsApp, Instagram, un CRM, la consola...).
 *
 * El bot SOLO conoce InboundEvent, OutboundMessage y ChannelAdapter — nunca el formato
 * particular de un canal. Cada canal traduce su propio formato hacia/desde estas formas.
 */

export interface InboundEvent {
  /** Nombre del canal por el que llegó el mensaje: "whatsapp", "instagram", "crm", "console"... */
  channel: string;
  /** Identifica al remitente DENTRO de ese canal (teléfono, usuario de IG, id de contacto...) */
  externalId: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: "audio" | "image";
  /** Id del archivo de media en el canal (fallback si no vino un link directo de descarga). */
  mediaId?: string;
  /** Link para descargar el media (normalmente pre-firmado y de un solo uso), si el canal lo entrega en el webhook. */
  mediaLink?: string;
  mediaMime?: string;
  timestamp: string;
  /** El payload original del canal, por si algún día se necesita — el bot no debe leerlo. */
  raw?: unknown;
}

/** Una sección del mensaje de catálogo (ver OutboundMessage.catalogo). */
export interface SeccionCatalogo {
  titulo: string;
  retailerIds: string[];
}

export interface OutboundMessage {
  to: string;
  text?: string;
  imageUrl?: string;
  /** URL directa a un archivo de video (mp4) — se manda como video NATIVO, no como link en texto. */
  videoUrl?: string;
  /**
   * [2026-09-15] Mensaje de catálogo (interactivo, gratis — NO es una plantilla de Marketing,
   * a diferencia del carrusel). Ver REFERENCIA-CATALOGO-WHATSAPP.md y
   * src/channels/whatsapp-ycloud/client.ts (sendMultiProductMessage). Cuando este campo viene
   * lleno, el adaptador manda ESE mensaje (ignora text/imageUrl/videoUrl de este mismo envío) —
   * el texto normal de la respuesta se manda aparte, como siempre.
   */
  catalogo?: {
    body: string;
    header?: string;
    footer?: string;
    secciones: SeccionCatalogo[];
  };
}

export interface ChannelAdapter {
  name: string;
  send(msg: OutboundMessage): Promise<void>;
  /**
   * [2026-09-14] Reconocimiento de audio: si el evento trae media (audio, y más adelante imagen)
   * sin texto, esto lo resuelve — descarga el archivo y lo transcribe/describe. Cada canal sabe
   * CÓMO bajar SU media (link firmado, auth propia, endpoint distinto...); el core (runTurn.ts)
   * solo llama a esto y nunca conoce el detalle de YCloud/WhatsApp ni de ningún otro canal.
   * Devuelve undefined si el canal no lo soporta o no se pudo resolver.
   */
  resolveMediaText?(event: InboundEvent): Promise<string | undefined>;
}

/**
 * [2026-09-17] Cuánto texto acepta WhatsApp como PIE DE FOTO (caption) de un video o una imagen:
 * el límite real de la API son 1024 caracteres, acá se usa 1000 para dejar margen. Importa
 * porque decide si el video y el texto viajan como UN SOLO mensaje (video con el texto de
 * caption: el orden queda garantizado, se ve el video arriba y el texto abajo) o como DOS
 * mensajes separados (ahí WhatsApp puede entregarlos en cualquier orden, porque el video tarda
 * más en procesarse que un texto plano — pasó en pruebas reales).
 *
 * Vive acá, en el contrato del canal, porque lo miran DOS lugares que tienen que coincidir sí o
 * sí: el pipeline al mandar (core/pipeline/runTurn.ts) y la herramienta al escribir el texto
 * (agentes/ventas/herramientas/planes.ts, que elige "☝️ Así se ve el plan en video" solo si va
 * a ir de caption, y una frase sin flecha si va a ir en un mensaje aparte). Si se separan, el
 * cliente lee una flecha que apunta a un video que no está arriba.
 */
export const LIMITE_CAPTION_WHATSAPP = 1000;
