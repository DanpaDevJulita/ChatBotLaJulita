import "dotenv/config";
import { registerChannel } from "../channels/registry.js";
import { whatsappYcloudAdapter } from "../channels/whatsapp-ycloud/adapter.js";
import { startInboundWorker } from "./inboundWorker.js";
import { startRecontactoWorker } from "./recontactoWorker.js";
import { startBloqueoWorker } from "./bloqueoWorker.js";

/**
 * Punto de entrada del proceso worker — corre SEPARADO del proceso web (src/web/start.ts).
 * Uso: npm run worker (con el proceso web corriendo aparte, npm run web, al mismo tiempo).
 *
 * Como es un proceso distinto (no comparte memoria con server.ts), tiene que registrar sus
 * propios canales acá — por eso este import de whatsappYcloudAdapter + registerChannel, igual
 * que hace server.ts para el proceso web.
 */
registerChannel(whatsappYcloudAdapter);

const worker = startInboundWorker();
const workerRecontacto = startRecontactoWorker();
const workerBloqueo = startBloqueoWorker();
console.log("Worker de La Julita escuchando las colas 'inbound', 'recontacto' y 'bloqueo' en Redis...");

function shutdown(signal: string): void {
  console.log(`[worker] Señal ${signal} recibida, cerrando...`);
  Promise.allSettled([worker.close(), workerRecontacto.close(), workerBloqueo.close()]).finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException:", err);
});
