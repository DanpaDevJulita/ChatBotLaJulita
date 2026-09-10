import readline from "node:readline";
import type { ChannelAdapter, InboundEvent, OutboundMessage } from "../types.js";

/**
 * Canal de "consola": deja chatear con el bot desde la terminal, sin WhatsApp real.
 * Sirve para probar el bot y sus herramientas mientras no tenemos credenciales de
 * YCloud/Bold/Supabase — y de paso prueba que la separación de canales funciona:
 * este adaptador implementa el MISMO contrato (ChannelAdapter) que va a implementar
 * el de WhatsApp más adelante.
 */
export function createConsoleAdapter(): {
  adapter: ChannelAdapter;
  start: (onMessage: (event: InboundEvent) => Promise<void>) => void;
} {
  const adapter: ChannelAdapter = {
    name: "console",
    async send(msg: OutboundMessage) {
      console.log(`\nBot (La Julita): ${msg.text ?? ""}`);
      if (msg.imageUrl) console.log(`  [imagen: ${msg.imageUrl}]`);
      console.log("");
    },
  };

  function start(onMessage: (event: InboundEvent) => Promise<void>) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Chat local con el bot de La Julita. Escribe "salir" para terminar.\n');
    rl.setPrompt("Tú: ");
    rl.prompt();

    let busy = false;

    rl.on("line", async (line) => {
      const text = line.trim();

      // Node emite "line" para cada línea disponible sin esperar a que el listener
      // anterior termine — sin este guard, un "salir" (o cualquier línea) que llega
      // mientras todavía estamos esperando la respuesta de la IA cerraría el proceso
      // a mitad de camino.
      if (busy) {
        console.log("(un momento, todavía estoy respondiendo lo anterior...)");
        return;
      }

      if (text.toLowerCase() === "salir") {
        rl.close();
        return;
      }

      const event: InboundEvent = {
        channel: "console",
        externalId: "local-user",
        text,
        timestamp: new Date().toISOString(),
      };

      busy = true;
      try {
        await onMessage(event);
      } catch (err) {
        console.error("Error procesando el mensaje:", err);
      } finally {
        busy = false;
        rl.prompt();
      }
    });

    rl.on("close", () => process.exit(0));
  }

  return { adapter, start };
}
