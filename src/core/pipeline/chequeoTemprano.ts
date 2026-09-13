import { ultimaReservaDeCelular } from "../db/pagosRepo.js";
import { confirmarBloqueo } from "../db/bloqueosRepo.js";
import { verificarPagoEnBold } from "./verificarPagoEnBold.js";
import { avisarPagoConfirmado } from "./avisarPago.js";
import { cancelarLiberacion, cancelarChequeosTempranos, type BloqueoJob } from "../queue/bloqueoQueue.js";

/**
 * [2026-09-13] "No podemos esperar ni confiarnos del webhook de Bold" — pidió el equipo. Mientras
 * el cupo sigue apartado (dentro de los BLOQUEO_MINUTOS de siempre), esto corre un par de veces
 * más por dentro (ver MINUTOS_CHEQUEO_TEMPRANO en bloqueoQueue.ts) para preguntarle a Bold si el
 * pago ya entró, en vez de depender solo de que el webhook llegue o de que el cliente escriba.
 *
 * Diferencia con el chequeo de bloqueo.ts (el de antes de liberar, a los BLOQUEO_MINUTOS): acá el
 * bloqueo TODAVÍA está vigente — no se venció, nadie más se lo pudo haber llevado — así que si
 * Bold dice que ya pagó, no hace falta re-verificar LobbyPMS (eso es solo para cuando el pago
 * llega DESPUÉS de que el cupo se soltó). Acá alcanza con confirmar el bloqueo y avisarle al
 * cliente.
 *
 * Si en algún momento YA se confirmó el pago por otro camino (el webhook, o un chequeo anterior
 * de estos mismos), el bloqueo ya no está "pendiente" y este chequeo no hace nada — aparte de
 * que, apenas se confirma un pago, se cancelan los chequeos que quedaran pendientes (ver
 * cancelarSeguimientoDePago), así que lo normal es que ni siquiera llegue a dispararse.
 */
export async function ejecutarChequeoTemprano(job: BloqueoJob): Promise<void> {
  const key = `${job.canal}:${job.externalId}`;

  const reservaId = await ultimaReservaDeCelular(job.externalId);
  if (!reservaId) {
    console.log(`[chequeoTemprano] ${key}: no encontré ninguna reserva para este chat — no hay nada que chequear.`);
    return;
  }

  let verificacion;
  try {
    verificacion = await verificarPagoEnBold(reservaId);
  } catch (err) {
    // Que falle esta consulta no rompe nada: el flujo normal (webhook, el cliente escribiendo,
    // o el chequeo final antes de liberar) sigue su curso igual.
    console.error(`[chequeoTemprano] ${key}: falló la consulta a Bold, sigo esperando el próximo chequeo:`, err);
    return;
  }

  if (!verificacion.pagado) {
    console.log(`[chequeoTemprano] ${key}: reserva #${reservaId} todavía sin pago — sigo esperando.`);
    return;
  }

  console.log(
    `[chequeoTemprano] ${key}: reserva #${reservaId} SÍ tiene el pago ` +
      `(${verificacion.yaEstabaRegistrado ? "ya estaba registrado — probablemente el webhook ya había llegado" : "lo detecté en este chequeo"}).`
  );

  // Dentro de la ventana del bloqueo el cupo sigue firme (todavía no se soltó ni pudo tomarlo
  // otro cliente) — a diferencia de bloqueo.ts, acá no hace falta re-verificar LobbyPMS.
  await confirmarBloqueo(job.bloqueoId);

  if (!verificacion.yaEstabaRegistrado) {
    await avisarPagoConfirmado({
      reservaId,
      totalPagado: verificacion.montoPagado,
      saldoPendiente: verificacion.saldoPendiente,
      estadoPago: verificacion.estadoPago,
      cupoAsegurado: true,
    });
  }

  // Ya quedó resuelto: ni el otro chequeo temprano ni la liberación de los BLOQUEO_MINUTOS tienen
  // ya nada que hacer — de lo contrario, a los 10 minutos se le volvería a preguntar a Bold algo
  // que ya sabemos.
  await cancelarLiberacion(job.bloqueoId);
  await cancelarChequeosTempranos(job.bloqueoId);
}
