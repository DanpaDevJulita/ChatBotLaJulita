import { getEstado, marcarReservaActiva } from "./estadoRepo.js";

/**
 * [2026-09-13] Qué reserva quedó activa en CADA conversación de WhatsApp — para que un cliente
 * nunca pueda terminar pagando la reserva de otro.
 *
 * POR QUÉ EXISTE — bug real encontrado en producción el 2026-09-13: Daniel probó el bot, registró
 * una reserva nueva (#7, plan de $5.000 de prueba) y al pedir pagar la mitad, el link que le
 * llegó fue de $190.000 — la mitad de OTRA reserva (#1, de una prueba de días antes, con OTRO
 * cliente). Lo que pasó: `enviar_datos_pago` recibe el `reserva_id` de lo que el MODELO decide
 * escribir en su llamada a la herramienta, y nada validaba que ese número perteneciera a esta
 * conversación. En una conversación larga (varias pruebas seguidas, el mismo chat) el modelo
 * terminó repitiendo un `reserva_id` viejo, y como esa reserva vieja YA tenía un link pendiente
 * sin pagar (`conseguirLink` reusa el link pendiente de un reserva_id+tipo), el bot lo reenvió
 * tal cual — con el monto de la reserva equivocada.
 *
 * [2026-09-13, misma tarde] PRIMERA versión de este archivo: un Map en memoria del proceso.
 * Arreglaba el bug, pero Daniel — pensando en cuando haya alta concurrencia (200+ conversaciones
 * a la vez, probablemente con más de un proceso corriendo el bot detrás de un balanceador) —
 * pidió ir a la raíz: un Map en memoria (a) NO se comparte entre procesos/réplicas — si el
 * balanceador manda el turno del pago a un proceso distinto del que registró la reserva, ese
 * proceso no sabe nada y el bug vuelve a abrirse; y (b) se pierde en cada reinicio (un deploy,
 * un crash).
 *
 * LA SOLUCIÓN DE FONDO: este dato ahora vive en la tabla `estado_conversacion` (columnas
 * `reserva_activa_id` / `reserva_activa_en`, ver sql/reserva-activa.sql) — la MISMA tabla donde
 * ya vive el resto del estado de la conversación (`last_agent`, el escalamiento a humano). Es
 * la fuente de verdad COMPARTIDA en la base, no la memoria de un proceso en particular: sirve
 * igual con uno o con diez procesos del bot corriendo a la vez.
 *
 * Este archivo queda como una capa fina sobre `estadoRepo.ts` (con el TTL de "hace cuánto se
 * anotó" como única lógica propia) para que `pago.ts`/`reserva.ts` no tengan que cambiar cómo
 * lo llaman.
 */

/** Una venta completa (de que el cliente escribe hasta que paga) no debería tardar más que esto. */
const TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

/** Se llama justo después de que `registrar_datos_reserva` crea la reserva con éxito. */
export async function recordarReservaActiva(channel: string, externalId: string, reservaId: number): Promise<void> {
  await marcarReservaActiva(channel, externalId, reservaId);
}

/** La reserva que ESTA conversación registró más recientemente, o null si no hay una vigente. */
export async function reservaActivaDe(channel: string, externalId: string): Promise<number | null> {
  const estado = await getEstado(channel, externalId);
  if (!estado.reserva_activa_id || !estado.reserva_activa_en) return null;

  const edadMs = Date.now() - new Date(estado.reserva_activa_en).getTime();
  if (edadMs > TTL_MS) return null;

  return estado.reserva_activa_id;
}
