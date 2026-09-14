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

export interface OutboundMessage {
  to: string;
  text?: string;
  imageUrl?: string;
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
