import type { ChannelAdapter, InboundEvent, OutboundMessage } from "../types.js";
import { sendTextMessage, sendImageMessage, sendVideoMessage, sendMultiProductMessage, descargarMedia } from "./client.js";
import { verifyYCloudSignature } from "./signature.js";
import { transcribirAudio } from "../../core/llm/whisper.js";

/** Teléfono E.164 válido: "+" seguido de 8 a 15 dígitos. */
function esTelefono(id: string | null | undefined): id is string {
  return !!id && /^\+\d{8,15}$/.test(id);
}

/** BSUID de WhatsApp (usuarios con @username y número oculto): "US.13491208655302741918". */
function esBsuid(id: string | null | undefined): id is string {
  return !!id && /^[A-Za-z]{2,}\.[A-Za-z0-9]+$/.test(id);
}

function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/[^\d]/g, "")}`;
}

/** YCloud entrega un link de descarga pre-firmado dentro del objeto de media; el nombre del
 *  campo varía según versión — se prueban los alias conocidos (igual que ingestMessage.ts en
 *  agente-ycloud-main). */
function extraerMediaLink(media: Record<string, unknown> | undefined): string | undefined {
  if (!media) return undefined;
  return (media.link ?? media.url ?? media.mediaUrl ?? media.downloadUrl) as string | undefined;
}

/**
 * [2026-09-18] Números de SIMULACRO: prefijos que el bot atiende normal pero a los que NUNCA les
 * manda un WhatsApp de verdad. Se configura con `SIMULACRO_PREFIJOS` en el .env (lista separada
 * por comas, en dígitos y sin "+": `SIMULACRO_PREFIJOS=5730009,5730008`).
 *
 * Para qué: poder correr una simulación de varios clientes a la vez contra el bot YA DESPLEGADO,
 * sin que salga un solo mensaje al mundo real. Sin esto, un simulacro contra la nube le mandaría
 * WhatsApps desde el número del negocio a cada número inventado — y los inventados caen en
 * prefijos reales de Colombia (300, 310, 320...), así que le pueden llegar a personas de verdad.
 *
 * Es una lista vacía por defecto: si nadie la configura, el bot se comporta exactamente como
 * siempre. Y vive acá, en el ÚNICO punto por donde sale un mensaje de WhatsApp, y no en el
 * pipeline: así no hay forma de rodearlo por otro camino (video, imagen, catálogo o texto).
 */
function prefijosDeSimulacro(): string[] {
  return (process.env.SIMULACRO_PREFIJOS ?? "")
    .split(",")
    .map((p) => p.replace(/\D/g, ""))
    .filter((p) => p.length >= 6); // un prefijo muy corto taparía números reales sin querer
}

export function esNumeroDeSimulacro(to: string): boolean {
  const digitos = (to ?? "").replace(/\D/g, "");
  if (!digitos) return false;
  return prefijosDeSimulacro().some((p) => digitos.startsWith(p));
}

export const whatsappYcloudAdapter: ChannelAdapter = {
  name: "whatsapp",
  async send(msg: OutboundMessage) {
    // El candado va ANTES que cualquier rama de envío, a propósito (ver esNumeroDeSimulacro).
    if (esNumeroDeSimulacro(msg.to)) {
      const que = msg.catalogo ? "catálogo" : msg.videoUrl ? "video" : msg.imageUrl ? "imagen" : "texto";
      console.log(
        `[simulacro] NO se manda el ${que} a ${msg.to} (número de simulacro): ` +
          `${(msg.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`
      );
      return;
    }

    if (msg.catalogo) {
      await sendMultiProductMessage(msg.to, msg.catalogo.body, msg.catalogo.secciones, {
        header: msg.catalogo.header,
        footer: msg.catalogo.footer,
      });
    } else if (msg.videoUrl) {
      await sendVideoMessage(msg.to, msg.videoUrl, msg.text);
    } else if (msg.imageUrl) {
      await sendImageMessage(msg.to, msg.imageUrl, msg.text);
    } else {
      await sendTextMessage(msg.to, msg.text ?? "");
    }
  },
  /**
   * [2026-09-14] Notas de voz de WhatsApp: se bajan con el link firmado que manda YCloud en el
   * propio webhook y se transcriben con el mismo modelo que usa el resto del bot (ver
   * core/llm/whisper.ts) — mismo enfoque que agente-ycloud-main/src/services/whisper.ts
   * ("Sebas Raider"), portado acá. Imagen: todavía no (ver TODO en parseYcloudWebhook).
   */
  async resolveMediaText(event: InboundEvent): Promise<string | undefined> {
    if (event.mediaType !== "audio") return undefined;
    if (!event.mediaLink && !event.mediaId) return undefined;
    const { buffer, mime } = await descargarMedia({ link: event.mediaLink, mediaId: event.mediaId });
    const texto = await transcribirAudio(buffer, event.mediaMime ?? mime);
    return texto.trim() || undefined;
  },
};

/**
 * Verifica la firma del webhook (header `ycloud-signature` + body crudo) y, si es válida,
 * devuelve los InboundEvent que trae el payload (normalmente uno). Lanza si la firma no es
 * válida — quien llama debe responder 401/400 y no seguir.
 */
export function parseYcloudWebhook(rawBody: Buffer, signatureHeader: string | undefined): InboundEvent[] {
  const check = verifyYCloudSignature(signatureHeader, rawBody);
  if (!check.ok) {
    throw new Error(`Firma de YCloud inválida: ${check.reason}`);
  }

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    throw new Error("JSON inválido en el webhook de YCloud");
  }

  const events = Array.isArray(payload) ? payload : [payload];
  const result: InboundEvent[] = [];

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, unknown>;
    const wim = (e.whatsappInboundMessage ?? e) as Record<string, unknown>;

    const fromRaw = (wim.from ?? wim.waId ?? wim.fromPhoneNumber) as string | undefined;
    const bsuid = (wim.fromUserId ?? wim.from_user_id ?? wim.fromParentUserId) as string | undefined;
    const telefono = fromRaw ? normalizePhone(fromRaw) : undefined;
    const externalId = esTelefono(telefono) ? telefono : esBsuid(bsuid) ? bsuid : undefined;
    if (!externalId) continue; // ni teléfono ni BSUID — evento de estado/plantilla, se ignora

    const type = (wim.type ?? wim.messageType) as string | undefined;
    const timestamp = String(wim.timestamp ?? wim.sentAt ?? new Date().toISOString());

    // [2026-09-17] El id del mensaje (el `wamid` de WhatsApp). Se leen varios nombres porque
    // YCloud no siempre usa el mismo según de dónde venga el evento, y el del envoltorio (`e.id`)
    // queda de último: identifica la ENTREGA del webhook, no el mensaje, así que dos entregas del
    // mismo mensaje podrían traer envoltorios distintos. Sirve para descartar una entrega
    // repetida — ver InboundEvent.messageId en src/channels/types.ts.
    const messageId = (wim.wamid ?? wim.id ?? wim.messageId ?? wim.message_id ?? e.id) as string | undefined;

    if (type === "text" || (wim.text && !type)) {
      const text = (wim.text as Record<string, unknown> | undefined)?.body ?? wim.body;
      result.push({
        channel: "whatsapp",
        externalId,
        messageId,
        text: typeof text === "string" ? text : "",
        timestamp,
        raw: ev,
      });
      continue;
    }

    if (type === "audio") {
      const audio = wim.audio as Record<string, unknown> | undefined;
      const mediaId = (audio?.id ?? audio?.mediaId ?? wim.mediaId) as string | undefined;
      const mime = (audio?.mimeType ?? audio?.mime ?? audio?.mime_type ?? "audio/ogg") as string;
      const mediaLink = extraerMediaLink(audio);
      result.push({
        channel: "whatsapp",
        externalId,
        messageId,
        mediaType: "audio",
        mediaId,
        mediaLink,
        mediaMime: mime,
        timestamp,
        raw: ev,
      });
      continue;
    }

    if (type === "image") {
      // TODO: cuando conectemos visión (como vision.ts del proyecto original), extraer el link
      // de media acá igual que se hizo arriba para audio.
      result.push({
        channel: "whatsapp",
        externalId,
        messageId,
        mediaType: "image",
        timestamp,
        raw: ev,
      });
    }
  }

  return result;
}
