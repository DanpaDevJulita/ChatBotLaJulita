import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Request, Response } from "express";
import session from "express-session";
import { parseYcloudWebhook, whatsappYcloudAdapter } from "../channels/whatsapp-ycloud/adapter.js";
import { registerChannel } from "../channels/registry.js";
import { enqueueInbound } from "../core/queue/inboundQueue.js";
import { adminApiRouter } from "./admin/routes.js";
import {
  verificarFirmaBold,
  extraerReferenceDelEvento,
  type BoldWebhookEvent,
} from "../core/integrations/boldClient.js";
import { registrarPagoAprobado } from "../core/db/pagosRepo.js";
import { bloqueoIdDeReserva } from "../core/db/bloqueosRepo.js";
import { avisarPagoConfirmado } from "../core/pipeline/avisarPago.js";
import { finalizarPagoConfirmado } from "../core/pipeline/confirmarReserva.js";

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

  // --- Webhook de Bold (confirma que el pago SI entro) --------------------------------------
  // [2026-09-11] Adaptado del bot base (agente-ycloud-main / "Sebas Raider"), mismo endpoint y
  // misma logica de verificacion — ver boldClient.ts para el detalle de la firma. La diferencia
  // es de monto: alla el link era de valor fijo por plan, aca es variable (calculado por
  // fn_total_reserva/fn_saldo_reserva) asi que el que confirma el pago (fn_registrar_pago_aprobado)
  // tambien actualiza el saldo real de la reserva, no solo un estado "pagado" binario.

  // Bold (o algo entre Bold y nosotros) puede hacer un chequeo GET/HEAD antes de mandar eventos
  // POST reales — visto asi en el bot base, sin esto el endpoint respondia 404 y podia hacer que
  // Bold no confiara en la URL configurada.
  app.get("/webhooks/bold", (_req: Request, res: Response) => res.status(200).json({ ok: true }));
  app.head("/webhooks/bold", (_req: Request, res: Response) => res.status(200).end());

  app.post("/webhooks/bold", async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const firma = req.headers["x-bold-signature"];
    const header = Array.isArray(firma) ? firma[0] : firma;

    const verificacion = verificarFirmaBold(header, rawBody);
    if (!verificacion.ok) {
      console.warn("[webhook bold] firma rechazada:", verificacion.razon);
      res.status(401).json({ ok: false, error: verificacion.razon });
      return;
    }
    // Deja registro de CUAL llave firmo (la doc de Bold es ambigua entre 2-3 candidatas) — el
    // primer webhook real en produccion resuelve la duda mirando esto en los logs.
    console.log("[webhook bold] firma ok, coincidio con:", verificacion.fuente);

    const payload = req.body as BoldWebhookEvent;

    // Solo nos interesa la venta aprobada. Los demas eventos (rechazos, anulaciones) se
    // reconocen con 200 para que Bold no siga reintentando, pero no tocan la base.
    if (payload?.type !== "SALE_APPROVED") {
      res.json({ ok: true, saltado: payload?.type ?? "sin_tipo" });
      return;
    }

    const referencia = extraerReferenceDelEvento(payload.data);
    const boldPaymentId = payload.data?.payment_id;
    const valor = payload.data?.amount?.total ?? null;

    if (!referencia || !boldPaymentId) {
      console.error("[webhook bold] SALE_APPROVED sin reference/payment_id — payload completo:", JSON.stringify(payload));
      res.json({ ok: true, saltado: "faltan_campos" });
      return;
    }

    try {
      const resultado = await registrarPagoAprobado({ referencia, boldPaymentId, valor });

      if (resultado.referenciaDesconocida) {
        console.warn("[webhook bold] SALE_APPROVED con una reference que no reconocemos:", referencia);
        res.json({ ok: true, saltado: "reference_desconocida" });
        return;
      }
      if (!resultado.ok) {
        console.error("[webhook bold] no se pudo registrar el pago:", referencia, resultado.motivo);
        res.status(500).json({ ok: false });
        return;
      }

      console.log(
        `[webhook bold] pago ${resultado.yaProcesado ? "ya estaba" : "quedo"} registrado — ` +
          `reserva #${resultado.reservaId}, estado_pago ${resultado.estadoPago}, saldo ${resultado.saldoPendiente}`
      );
      // Bold exige responder en menos de 2s — un solo RPC a Supabase entra sobrado ahi, por eso
      // se espera el resultado antes de responder (a diferencia del webhook de WhatsApp, que
      // encola y responde antes de procesar): asi, si la escritura falla, Bold reintenta.
      res.json({ ok: true });

      // [2026-09-11] Recien AHORA (ya respondido) se le avisa al cliente por WhatsApp que su
      // pago entro, para que no tenga que mandar el comprobante. Va despues del res.json() a
      // proposito: mandar un mensaje por YCloud es una llamada HTTP mas y no cabe dentro de los
      // 2 segundos que Bold da para contestar — si nos pasamos, Bold da el webhook por fallido
      // y lo reintenta, y el cliente terminaria recibiendo el aviso varias veces.
      //
      // `yaProcesado` es la guarda de idempotencia: Bold puede mandar la misma notificacion mas
      // de una vez (su doc lo advierte) y el aviso tiene que salir UNA sola vez.
      if (!resultado.yaProcesado && resultado.reservaId != null) {
        void avisarPagoConfirmado({
          reservaId: resultado.reservaId,
          totalPagado: resultado.totalPagado,
          saldoPendiente: resultado.saldoPendiente,
          estadoPago: resultado.estadoPago,
        }).catch((err) => console.error("[webhook bold] fallo el aviso al cliente (el pago SI quedo registrado):", err));

        // [2026-09-14] El webhook ya confirmo el pago: se cierra TODO lo que falta — se marca el
        // bloqueo como confirmado, se cancelan los chequeos pendientes y, lo mas importante, se
        // crea la reserva REAL en LobbyPMS. Antes esto ultimo solo pasaba con el /confirmar
        // manual del equipo, asi que un pago confirmado solo por el webhook dejaba al cliente con
        // su confirmacion por escrito y a La Julita sin nada reservado (ver confirmarReserva.ts).
        void bloqueoIdDeReserva(resultado.reservaId)
          .then((bloqueoId) =>
            finalizarPagoConfirmado({
              bloqueoId,
              reservaId: resultado.reservaId,
              origen: "webhook-bold",
            })
          )
          .catch((err) => console.error("[webhook bold] no pude cerrar la confirmacion del bloqueo:", err));
      }
    } catch (err) {
      console.error("[webhook bold] error inesperado:", err);
      res.status(500).json({ ok: false });
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
