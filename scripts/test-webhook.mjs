// Prueba el webhook firmando el body como lo haría YCloud de verdad
// (t=<unix>,s=<hmac-sha256 de "{t}.{rawBody}">). Solo para desarrollo.
import crypto from "node:crypto";

const secret = process.env.YCLOUD_WEBHOOK_SECRET ?? "testsecret";
const url = process.env.WEBHOOK_URL ?? "http://localhost:3001/webhooks/whatsapp";

const body = JSON.stringify({
  whatsappInboundMessage: {
    from: "+573001112233",
    type: "text",
    text: { body: "cual es la ubicacion?" },
  },
});

const t = Math.floor(Date.now() / 1000);
const s = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "ycloud-signature": `t=${t},s=${s}` },
  body,
});
console.log(res.status, await res.text());
