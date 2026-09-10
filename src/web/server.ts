import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Request, Response } from "express";
import session from "express-session";
import { parseYcloudWebhook, whatsappYcloudAdapter } from "../channels/whatsapp-ycloud/adapter.js";
import { registerChannel } from "../channels/registry.js";
import { enqueueInbound } from "../core/queue/inboundQueue.js";
import { adminApiRouter } from "./admin/routes.js";

registerChannel(whatsappYcloudAdapter);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PUBLIC_DIR = path.join(__dirname, "admin", "public");

export function createApp() {
  const app = express();

  // Guardamos el body crudo (Buffer) porque la firma de YCloud se calcula sobre el texto
  // exacto que llegó, antes de parsear el JSON — igual que rawBody.ts en el proyecto original.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/webhooks/whatsapp", (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const signature = req.headers["ycloud-signature"];
    const header = Array.isArray(signature) ? signature[0] : signature;

    let events;
    try {
      events = parseYcloudWebhook(rawBody, header);
    } catch (err) {
      console.warn("Webhook de WhatsApp rechazado:", (err as Error).message);
      res.status(401).json({ ok: false, error: (err as Error).message });
      return;
    }

    // Respondemos YA — WhatsApp/YCloud espera un 200 rápido y reintenta si se demora.
    // A partir de acá ya NO procesamos el mensaje en este proceso: solo lo encolamos en Redis
    // (ver core/queue/inboundQueue.ts) — un proceso worker separado (`npm run worker`) es quien
    // de verdad le habla al LLM y responde al cliente. Así este proceso web nunca se bloquea
    // ni se cae por un mensaje problemático, y si el worker está caído un momento, el mensaje
    // no se pierde: queda esperando en la cola hasta que vuelva a estar arriba.
    res.json({ ok: true });

    for (const event of events) {
      enqueueInbound(event).catch((err) => {
        console.error("Error encolando mensaje de WhatsApp:", err);
      });
    }
  });

  // --- Panel de administración -------------------------------------------------------------
  // Sesión en memoria del proceso: suficiente para "un usuario/clave compartido" (si el
  // servidor se reinicia, hay que volver a iniciar sesión — no es grave para este caso de uso).
  app.use(
    session({
      secret: process.env.SESSION_SECRET ?? "cambia-esto-en-.env-antes-de-producción",
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 horas
    })
  );

  // (el express.json() global de arriba ya cubre estas rutas también — no hace falta repetirlo)
  app.use("/admin/api", adminApiRouter);
  app.use("/admin", express.static(ADMIN_PUBLIC_DIR));

  return app;
}
