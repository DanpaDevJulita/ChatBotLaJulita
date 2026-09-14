import { getChannel } from "../../channels/registry.js";
import { numerosAutorizados } from "./comandos.js";

/**
 * [2026-09-10] Aviso real al equipo cuando se escala una conversación a humano — punto 4 de
 * la lista ("notificaciones a los humanos a cargo del escalamiento"), que el usuario pidió
 * resolver junto con el punto 3 (reglas de escalamiento).
 *
 * Antes de esto, el escalamiento quedaba SOLO en los logs del servidor y en el panel de
 * administración — nadie del equipo se enteraba salvo que estuviera mirando cualquiera de
 * los dos en ese momento. Ahora se manda un WhatsApp directo a cada número de
 * OWNER_WHATSAPP_NUMBERS (el mismo mecanismo de src/core/pipeline/comandos.ts, reutilizado
 * acá para no duplicar la lista de números).
 *
 * Siempre por WhatsApp ("whatsapp" es el canal registrado, ver src/channels/registry.ts),
 * SIN IMPORTAR por qué canal escribió el cliente (Instagram, etc. algún día) — es donde el
 * equipo ya recibe los comandos /corrige y demás, así no hace falta un canal nuevo para esto.
 *
 * Nunca deja que un fallo acá (WhatsApp caído, número mal puesto) tumbe el turno del
 * cliente: se loguea y listo, igual que enviarSeguro.ts.
 */
export async function notificarEscalamiento(params: {
  canalCliente: string;
  externalIdCliente: string;
  motivo: string;
  mensajeCliente: string;
}): Promise<void> {
  const numeros = numerosAutorizados();
  if (numeros.length === 0) {
    console.warn(
      "[notificarEquipo] Se escaló una conversación a humano pero OWNER_WHATSAPP_NUMBERS está " +
        "vacío — nadie del equipo recibe el aviso por WhatsApp. Queda solo en los logs y en el panel."
    );
    return;
  }

  const texto =
    `🆘 Un cliente necesita a una persona del equipo\n\n` +
    `Canal: ${params.canalCliente}\n` +
    `Cliente: ${params.externalIdCliente}\n` +
    `Motivo: ${params.motivo || "(sin motivo puntual)"}\n\n` +
    `Último mensaje del cliente:\n"${params.mensajeCliente}"\n\n` +
    `Cuando ya lo resolviste, mandá "/resuelto ${params.externalIdCliente}" para que el bot vuelva a atenderlo normal.`;

  let whatsapp;
  try {
    whatsapp = getChannel("whatsapp");
  } catch (err) {
    console.error("[notificarEquipo] No hay canal 'whatsapp' registrado en este proceso — no se pudo avisar:", err);
    return;
  }

  for (const numero of numeros) {
    try {
      await whatsapp.send({ to: numero, text: texto });
    } catch (err) {
      console.error(`[notificarEquipo] Falló el aviso a ${numero}:`, err);
    }
  }
}

/**
 * [2026-09-14] Aviso al equipo de VENTAS cuando un cliente ya pagó (y ya recibió su confirmación
 * por WhatsApp) pero la reserva NO se pudo crear sola en LobbyPMS.
 *
 * Es el aviso más importante que manda este bot: en ese momento hay un cliente con una
 * confirmación por escrito y un cupo que, en el calendario de La Julita, no existe. Si nadie la
 * crea a mano, esa fecha se le puede vender a otra persona. Por eso va por WhatsApp al equipo
 * (acá) y además al canal técnico (ver notificarDesarrollo.ts) — es preferible avisar de más.
 *
 * Nunca lanza: si esto falla, el detalle igual queda completo en los logs.
 */
export async function avisarReservaNoCreadaEnLobby(params: {
  bloqueoId: number;
  reservaId: number | null;
  externalIdCliente: string | null;
  fechaEntrada: string | null;
  motivo: string;
}): Promise<void> {
  const numeros = numerosAutorizados();
  if (numeros.length === 0) {
    console.error(
      "[notificarEquipo] ¡Reserva pagada SIN crear en LobbyPMS y OWNER_WHATSAPP_NUMBERS está vacío! " +
        `Bloqueo #${params.bloqueoId} — nadie del equipo se va a enterar por WhatsApp.`
    );
    return;
  }

  const texto =
    `🚨 Reserva PAGADA que hay que crear A MANO en LobbyPMS\n\n` +
    `El cliente ya pagó y el bot ya le confirmó la reserva, pero no se pudo crear en LobbyPMS.\n\n` +
    `Cliente: ${params.externalIdCliente ?? "(sin número)"}\n` +
    (params.reservaId ? `Reserva (nuestra base): #${params.reservaId}\n` : "") +
    `Bloqueo: #${params.bloqueoId}\n` +
    (params.fechaEntrada ? `Fecha de entrada: ${params.fechaEntrada}\n` : "") +
    `\nMotivo: ${params.motivo}\n\n` +
    `⚠️ Hasta que se cree allá, esa fecha puede venderse a otra persona.`;

  let whatsapp;
  try {
    whatsapp = getChannel("whatsapp");
  } catch (err) {
    console.error("[notificarEquipo] No hay canal 'whatsapp' registrado — no se pudo avisar:", err);
    return;
  }

  for (const numero of numeros) {
    try {
      await whatsapp.send({ to: numero, text: texto });
    } catch (err) {
      console.error(`[notificarEquipo] Falló el aviso de reserva sin crear a ${numero}:`, err);
    }
  }
}
