import crypto from "node:crypto";

/**
 * YCloud manda `YCloud-Signature: t=<unix-seconds>,s=<hex-hmac>`. Lo firmado es
 * `{timestamp}.{rawBody}` (el body EXACTO tal como llegó, antes de parsear el JSON), con
 * HMAC-SHA256 usando YCLOUD_WEBHOOK_SECRET. Portado de agente-ycloud-main/src/lib/hash.ts.
 */
export type SignatureCheckResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" | "no_secret" };

const FRESHNESS_SECONDS = Number(process.env.WEBHOOK_FRESHNESS_SECONDS ?? "300");

export function verifyYCloudSignature(
  header: string | undefined,
  rawBody: Buffer | string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SignatureCheckResult {
  const secret = process.env.YCLOUD_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!header) return { ok: false, reason: "missing" };

  const map = new Map<string, string>();
  for (const part of header.split(",").map((p) => p.trim())) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  const t = map.get("t");
  const s = map.get("s");
  if (!t || !s) return { ok: false, reason: "malformed" };

  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - ts) > FRESHNESS_SECONDS) return { ok: false, reason: "stale" };

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${bodyStr}`).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(s, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
