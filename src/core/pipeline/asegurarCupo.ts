import { bloqueoPorId, confirmarBloqueo, reactivarBloqueo, type Bloqueo } from "../db/bloqueosRepo.js";
import { consultarDisponibilidad, crearBlockLobby, resolverCategoryId } from "../integrations/lobbypms.js";
import { BLOQUEO_MINUTOS } from "../queue/bloqueoQueue.js";

/**
 * [2026-09-11] ¿El cupo está REALMENTE asegurado en LobbyPMS, y si no, se puede volver a tomar?
 *
 * El problema que resuelve, encontrado probando en producción: un cliente pagó pasados los 10
 * minutos. Para entonces el bloqueo ya se había vencido y el cupo en LobbyPMS ya estaba liberado.
 * El bot registró el pago y le dijo "tu reserva queda confirmada ✅" — pero en LobbyPMS no había
 * nada. Le prometimos al cliente algo que el negocio no tenía asegurado, que es la peor forma de
 * fallar: el cliente llega al glamping y no hay dónde alojarlo.
 *
 * La regla, dicha por el equipo: NO se le confirma nada al cliente hasta tener certeza de que la
 * reserva está en LAS DOS partes — en nuestra base y en LobbyPMS.
 *
 * Esta función es la que da esa certeza. Nunca miente: si no puede comprobarlo, devuelve
 * "no_verificable" y quien llama tiene que tratarlo como NO asegurado.
 */
export type EstadoDelCupo =
  /** El cupo está tomado en LobbyPMS (ya lo estaba, o se acaba de volver a tomar). */
  | "asegurado"
  /** Se consultó y esa fecha ya no tiene disponibilidad: el cupo se perdió. */
  | "sin_cupo"
  /** No se pudo comprobar (API caída, sin token, faltan datos del bloqueo). Se trata como NO asegurado. */
  | "no_verificable";

export interface ResultadoCupo {
  estado: EstadoDelCupo;
  /** Se tuvo que volver a tomar el cupo porque el bloqueo original ya se había vencido. */
  reactivado: boolean;
  motivo?: string;
  bloqueo?: Bloqueo;
  /** Cuántas veces se intentó en total (solo lo llena `asegurarCupoConReintentos`). */
  intentos?: number;
}

export async function asegurarCupo(bloqueoId: number): Promise<ResultadoCupo> {
  const bloqueo = await bloqueoPorId(bloqueoId);
  if (!bloqueo) {
    return { estado: "no_verificable", reactivado: false, motivo: `no encontré el bloqueo #${bloqueoId}` };
  }

  // 1. ¿Ya hay una reserva real creada en LobbyPMS? Entonces está asegurado y no hay nada que hacer.
  if (bloqueo.lobby_booking_id) {
    return { estado: "asegurado", reactivado: false, bloqueo, motivo: "ya existe la reserva en LobbyPMS" };
  }

  // 2. ¿El bloqueo sigue vivo y con su candado real en LobbyPMS? El cupo está tomado.
  const vigente = bloqueo.estado === "pendiente" || bloqueo.estado === "confirmado";
  if (vigente && bloqueo.lobby_block_id) {
    // Se marca confirmado: está pago y el cupo está tomado, así que ya no es un candado "a la
    // espera" — dejarlo en `pendiente` haría que algo lo pudiera soltar más adelante.
    if (bloqueo.estado !== "confirmado") await confirmarBloqueo(bloqueo.id);
    return { estado: "asegurado", reactivado: false, bloqueo, motivo: "el bloqueo en LobbyPMS sigue vigente" };
  }

  // 3. El cupo se soltó (pago tardío). Hay que mirar si la fecha TODAVÍA tiene disponibilidad y,
  //    si la tiene, volver a tomarla. Esto es lo que evita confirmarle al cliente una fecha que
  //    ya se vendió mientras él pagaba.
  if (!bloqueo.lobby_category_id) {
    const categoria = await resolverCategoryId(bloqueo.clase_domo, bloqueo.capacidad, bloqueo.fecha_entrada, 1).catch(() => null);
    if (categoria) bloqueo.lobby_category_id = categoria;
  }

  const disponibilidad = await consultarDisponibilidad(bloqueo.fecha_entrada, Math.max(1, bloqueo.noches ?? 1)).catch(() => null);
  if (!disponibilidad) {
    return {
      estado: "no_verificable",
      reactivado: false,
      bloqueo,
      motivo: "no pude consultar la disponibilidad en LobbyPMS",
    };
  }

  const paraSuClase = disponibilidad.find(
    (d) => d.clase === bloqueo.clase_domo && d.capacidad === bloqueo.capacidad
  );
  if (!paraSuClase || paraSuClase.disponibles <= 0) {
    return {
      estado: "sin_cupo",
      reactivado: false,
      bloqueo,
      motivo: `ya no queda disponibilidad de ${bloqueo.clase_domo} (cap. ${bloqueo.capacidad}) para el ${bloqueo.fecha_entrada}`,
    };
  }

  // Hay cupo: se vuelve a tomar, para que nadie más lo agarre mientras el equipo confirma.
  if (!bloqueo.lobby_category_id) {
    return {
      estado: "no_verificable",
      reactivado: false,
      bloqueo,
      motivo: "hay disponibilidad pero no pude resolver la categoría de LobbyPMS para volver a bloquearla",
    };
  }

  const nuevo = await crearBlockLobby({
    categoryId: bloqueo.lobby_category_id,
    fechaEntradaISO: bloqueo.fecha_entrada,
    // `end_date` es INCLUSIVO en LobbyPMS (la última noche, no el día de salida) — ver lobbypms.ts.
    fechaUltimaNocheISO: bloqueo.fecha_entrada,
    minutos: Math.max(BLOQUEO_MINUTOS, 60),
    nota: `Pago confirmado fuera de tiempo — reserva ${bloqueo.id} (bot La Julita)`,
  }).catch(() => null);

  if (!nuevo) {
    return {
      estado: "no_verificable",
      reactivado: false,
      bloqueo,
      motivo: "hay disponibilidad pero LobbyPMS no aceptó el nuevo bloqueo",
    };
  }

  // `reactivarBloqueo` (no `guardarBlockLobby` + `confirmarBloqueo`): el bloqueo puede llegar
  // acá en estado "liberado" (se venció de verdad, o un intento anterior de este mismo job ya lo
  // liberó) y `confirmarBloqueo` a propósito NO pisa nada que no esté "pendiente". Acá sí hay que
  // pisarlo: se acaba de comprobar disponibilidad y crear el bloqueo real en LobbyPMS hace un
  // instante, así que es información fresca y autoritativa, no una confirmación a ciegas.
  await reactivarBloqueo(bloqueo.id, nuevo.blockId, bloqueo.lobby_category_id);

  console.log(
    `[asegurarCupo] bloqueo #${bloqueo.id}: el cupo se había soltado, pero había disponibilidad y lo volví ` +
      `a tomar en LobbyPMS (block ${nuevo.blockId}).`
  );

  return { estado: "asegurado", reactivado: true, bloqueo, motivo: "se volvió a tomar el cupo" };
}

/**
 * [2026-09-11] "No quiero que me escale nada, de ser muy necesario" — pidió el equipo. Antes de
 * darle esto por perdido y avisarle al equipo, se le dan varias vueltas por si el problema fue
 * un tropiezo pasajero de LobbyPMS (un timeout, un 5xx) y no una falta de disponibilidad real.
 *
 * Solo tiene sentido reintentar cuando el resultado es "no_verificable" — no se pudo consultar.
 * Si LobbyPMS SÍ contestó y dijo que no hay disponibilidad ("sin_cupo"), reintentar no cambia
 * nada: no hay nada que esperar, así que se corta ahí mismo y punto.
 *
 * `asegurado === false` al salir de acá quiere decir, de verdad, "hay que escalar": o LobbyPMS
 * confirmó que no queda nada, o se le preguntó varias veces y nunca se pudo saber con certeza.
 * Ninguna de las dos formas de "no" se inventa un cupo que no se pudo comprobar.
 */
export const MAX_INTENTOS_CUPO = Math.max(1, Number(process.env.MAX_INTENTOS_CUPO ?? 3));
export const ESPERA_ENTRE_INTENTOS_CUPO_MS = Math.max(0, Number(process.env.ESPERA_ENTRE_INTENTOS_CUPO_MS ?? 4000));

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

export async function asegurarCupoConReintentos(bloqueoId: number): Promise<ResultadoCupo> {
  let intento = 1;
  let resultado = await asegurarCupo(bloqueoId);

  while (resultado.estado === "no_verificable" && intento < MAX_INTENTOS_CUPO) {
    intento++;
    console.warn(
      `[asegurarCupo] bloqueo #${bloqueoId}: no se pudo verificar (intento ${intento - 1}) — ` +
        `reintento ${intento}/${MAX_INTENTOS_CUPO} en ${ESPERA_ENTRE_INTENTOS_CUPO_MS}ms antes de pensar en escalar.`
    );
    await esperar(ESPERA_ENTRE_INTENTOS_CUPO_MS);
    resultado = await asegurarCupo(bloqueoId);
  }

  return { ...resultado, intentos: intento };
}
