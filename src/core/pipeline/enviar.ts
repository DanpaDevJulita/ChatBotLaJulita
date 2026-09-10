import type { ChannelAdapter } from "../../channels/types.js";

/**
 * [2026-09-08] `adapter.send` es la última posta antes de que el mensaje llegue de verdad al
 * cliente (para WhatsApp, una llamada HTTP a la API de YCloud) — si falla (red, YCloud caído,
 * número inválido) NO queremos que la excepción se lleve por delante todo el turno sin dejar
 * rastro claro. Con su propio log queda evidente en la consola cuándo el bot generó una
 * respuesta pero no logró entregarla, que es muy distinto de un fallo del modelo.
 *
 * Vive en su propio archivo porque lo usan tanto el turno normal (runTurn.ts) como los
 * recontactos automáticos (recontacto.ts).
 */
export async function enviarSeguro(
  adapter: ChannelAdapter,
  to: string,
  text: string,
  key: string
): Promise<boolean> {
  try {
    await adapter.send({ to, text });
    return true;
  } catch (err) {
    console.error(
      `[enviar] Falló el envío al cliente por "${adapter.name}" — ${key}: el mensaje quedó generado pero NO entregado.`,
      err
    );
    return false;
  }
}
