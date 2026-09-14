import { bloqueoPorId, bloqueoPendienteDe, confirmarBloqueo, type Bloqueo } from "../db/bloqueosRepo.js";
import { cancelarSeguimientoDePago } from "../queue/bloqueoQueue.js";
import { crearReservaRealDesdeBloqueo, type ResultadoReservaLobby } from "./reservaLobby.js";
import { avisarReservaNoCreadaEnLobby } from "./notificarEquipo.js";
import { alertarFalloTecnico } from "./notificarDesarrollo.js";

/**
 * [2026-09-14] Un solo lugar para todo lo que hay que hacer cuando un pago queda confirmado.
 *
 * EL BUG QUE ARREGLA (encontrado por Daniel probando el 13/09, con captura de WhatsApp): el bot
 * le dijo al cliente "tu reserva queda apartada ✅"... y en LobbyPMS no había ninguna reserva. A
 * los 10 minutos el cupo se soltó. O sea: el cliente pagó, tenía la confirmación por escrito, y
 * el glamping no tenía nada reservado — el cupo quedó libre para que lo tomara otro.
 *
 * Por qué pasaba: la reserva REAL en LobbyPMS se creaba en UN SOLO camino — el comando manual
 * `/confirmar` que manda el equipo por WhatsApp (ver comandos.ts). Todos los caminos AUTOMÁTICOS
 * (el webhook de Bold, el cliente diciendo "ya pagué" → `verificar_pago`, y los chequeos de los
 * 3/7 minutos) confirmaban el pago y le escribían al cliente, pero nunca creaban la reserva allá.
 * Mientras el equipo confirmaba a mano no se notaba; apenas el bot empezó a confirmar solo, se
 * volvió el agujero más caro que puede tener este bot.
 *
 * Ahora los cuatro caminos pasan por acá y hacen exactamente lo mismo:
 *   1. Marcan el bloqueo como confirmado en la base (deja de estar sujeto a la liberación).
 *   2. Cancelan lo que quede en la cola para ese bloqueo (liberación y chequeos tempranos).
 *   3. Crean la reserva real en LobbyPMS.
 *
 * Es idempotente: si la reserva ya se creó (el bloqueo guarda `lobby_booking_id`), no se vuelve a
 * crear por más veces que se llame — y se llama desde varios lados a la vez a propósito, porque
 * es preferible intentarlo de más que quedarse sin reserva.
 *
 * Si LobbyPMS falla, el pago NO se deshace nunca (el cliente pagó, eso es sagrado): se le avisa
 * al equipo de ventas por WhatsApp para que la cree a mano, y al equipo técnico por el canal de
 * avisos. Lo que no puede volver a pasar es que nadie se entere.
 */
export interface ResultadoConfirmacion {
  bloqueoId: number | null;
  /** null si no hizo falta crear nada (ya existía) o si no había bloqueo que confirmar. */
  lobby: ResultadoReservaLobby | null;
}

export async function finalizarPagoConfirmado(params: {
  /** Si ya se sabe cuál es el bloqueo (el job de la cola lo trae). */
  bloqueoId?: number | null;
  /** Si no se sabe, se busca el bloqueo pendiente de esta conversación. */
  canal?: string;
  externalId?: string;
  /** Reserva asociada, solo para los avisos al equipo. */
  reservaId?: number | null;
  /** Quién está confirmando, para los logs: "webhook-bold", "verificar_pago", etc. */
  origen: string;
}): Promise<ResultadoConfirmacion> {
  const { origen } = params;

  let bloqueo: Bloqueo | null = null;
  try {
    if (params.bloqueoId) {
      bloqueo = await bloqueoPorId(params.bloqueoId);
    } else if (params.canal && params.externalId) {
      bloqueo = await bloqueoPendienteDe(params.canal, params.externalId);
    }
  } catch (err) {
    console.error(`[confirmarReserva:${origen}] no pude leer el bloqueo:`, err);
  }

  if (!bloqueo) {
    // Puede ser normal: un pago de saldo, o una reserva que el equipo armó por fuera del bot.
    console.log(`[confirmarReserva:${origen}] no hay bloqueo que confirmar para este pago.`);
    return { bloqueoId: null, lobby: null };
  }

  // Ya se había creado la reserva real: no hay nada más que hacer (idempotencia).
  if (bloqueo.lobby_booking_id) {
    console.log(
      `[confirmarReserva:${origen}] el bloqueo #${bloqueo.id} ya tiene la reserva de LobbyPMS ` +
        `#${bloqueo.lobby_booking_id} — no hago nada.`
    );
    return { bloqueoId: bloqueo.id, lobby: null };
  }

  if (bloqueo.estado !== "confirmado") {
    await confirmarBloqueo(bloqueo.id);
  }

  // Ya está pago: no tiene sentido seguir preguntándole a Bold ni liberar nada.
  try {
    await cancelarSeguimientoDePago(bloqueo.id);
  } catch (err) {
    console.warn(`[confirmarReserva:${origen}] no pude cancelar el seguimiento del bloqueo #${bloqueo.id}:`, err);
  }

  const lobby = await crearReservaRealDesdeBloqueo(bloqueo);

  if (lobby.ok) {
    console.log(
      `[confirmarReserva:${origen}] bloqueo #${bloqueo.id}: reserva creada en LobbyPMS #${lobby.bookingId}.`
    );
    return { bloqueoId: bloqueo.id, lobby };
  }

  // No se pudo crear allá. El cliente YA tiene su confirmación, así que esto tiene que llegarle a
  // una persona sí o sí — por los dos canales, porque es plata y cupo.
  console.error(
    `[confirmarReserva:${origen}] bloqueo #${bloqueo.id}: NO se pudo crear la reserva en LobbyPMS ` +
      `(${lobby.motivo}) — hay que crearla a mano.`
  );

  void avisarReservaNoCreadaEnLobby({
    bloqueoId: bloqueo.id,
    reservaId: params.reservaId ?? null,
    externalIdCliente: bloqueo.external_id ?? params.externalId ?? null,
    fechaEntrada: bloqueo.fecha_entrada ?? null,
    motivo: lobby.motivo ?? "sin detalle",
  });

  void alertarFalloTecnico({
    clave: "lobbypms:reserva_no_creada",
    titulo: "LobbyPMS: no se pudo crear una reserva ya pagada",
    detalle:
      `bloqueo #${bloqueo.id}${params.reservaId ? `, reserva #${params.reservaId}` : ""} ` +
      `(${origen}): ${lobby.motivo}. El cliente YA tiene la confirmación — hay que crearla a mano.`,
  });

  return { bloqueoId: bloqueo.id, lobby };
}
