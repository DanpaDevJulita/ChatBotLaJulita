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
}
