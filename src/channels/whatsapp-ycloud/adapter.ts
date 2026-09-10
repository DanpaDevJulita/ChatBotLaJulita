import type { ChannelAdapter, InboundEvent, OutboundMessage } from "../types.js";
import { sendTextMessage, sendImageMessage } from "./client.js";
import { verifyYCloudSignature } from "./signature.js";

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

export const whatsappYcloudAdapter: ChannelAdapter = {
  name: "whatsapp",
  async send(msg: OutboundMessage) {
    if (msg.imageUrl) {
      await sendImageMessage(msg.to, msg.imageUrl, msg.text);
    } else {
      await sendTextMessage(msg.to, msg.text ?? "");
    }
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

    if (type === "text" || (wim.text && !type)) {
      const text = (wim.text as Record<string, unknown> | undefined)?.body ?? wim.body;
      result.push({
        channel: "whatsapp",
        externalId,
        text: typeof text === "string" ? text : "",
        timestamp,
        raw: ev,
      });
      continue;
    }

    if (type === "audio" || type === "image") {
      // TODO: cuando conectemos transcripción/visión (como whisper.ts/vision.ts del proyecto
      // original), extraer el link de media aquí igual que hace ingestMessage.ts allá.
      result.push({
        channel: "whatsapp",
        externalId,
        mediaType: type,
        timestamp,
        raw: ev,
      });
    }
  }

  return result;
}
