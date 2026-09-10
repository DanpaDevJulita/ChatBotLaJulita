import "dotenv/config";
import { createConsoleAdapter } from "../src/channels/console/adapter.js";
import { handleInbound } from "../src/core/pipeline/runTurn.js";

/**
 * Punto de entrada para chatear con el bot desde la terminal, sin WhatsApp real.
 * Uso: npm run chat:local
 */
const { adapter, start } = createConsoleAdapter();
start(async (event) => {
  await handleInbound(event, adapter);
});
