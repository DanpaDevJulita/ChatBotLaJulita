/**
 * Ventana nocturna para los recontactos, en hora de Colombia. Portado de
 * agente-ycloud-main/src/lib/quietHours.ts (allá la config venía de un módulo `env` validado
 * con Zod; acá se lee directo de process.env, que es el patrón de este proyecto).
 *
 * Colombia (America/Bogotá) es UTC-5 fijo todo el año — no tiene horario de verano — así que
 * la conversión se hace con un offset constante, sin dependencias de zona horaria.
 */
const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;

function activo(): boolean {
  return process.env.QUIET_HOURS_ENABLED !== "false";
}
function horaInicio(): number {
  return Number(process.env.QUIET_HOURS_START_HOUR ?? 21);
}
function horaFin(): number {
  return Number(process.env.QUIET_HOURS_END_HOUR ?? 7);
}

function horaBogotaDe(utcMs: number): number {
  return Math.floor((((utcMs + BOGOTA_OFFSET_MS) % DIA_MS) + DIA_MS) % DIA_MS / HORA_MS);
}

/** true si ese instante cae en la ventana nocturna (hora de Colombia). */
export function esHorarioNocturno(utcMs: number = Date.now()): boolean {
  if (!activo()) return false;
  const hora = horaBogotaDe(utcMs);
  const inicio = horaInicio();
  const fin = horaFin();
  // Ventana que cruza medianoche (ej. 21 -> 7) vs. ventana normal (ej. 1 -> 4).
  return inicio > fin ? hora >= inicio || hora < fin : hora >= inicio && hora < fin;
}

/**
 * Si el instante cae de noche, lo corre a la hora de fin (ej. 7:00 am de Colombia); si no, lo
 * devuelve igual. Nadie quiere que el glamping le escriba a las 3 de la mañana.
 */
export function ajustarPorHorarioNocturno(utcMs: number): number {
  if (!esHorarioNocturno(utcMs)) return utcMs;
  const bogotaMs = utcMs + BOGOTA_OFFSET_MS;
  const inicioDiaBogota = bogotaMs - (((bogotaMs % DIA_MS) + DIA_MS) % DIA_MS);
  const hora = horaBogotaDe(utcMs);
  const fin = horaFin();
  // Si la hora de fin de hoy ya pasó (ej. son las 11 pm y el fin es 7 am), va al día siguiente.
  const finBogotaMs = hora >= fin ? inicioDiaBogota + DIA_MS + fin * HORA_MS : inicioDiaBogota + fin * HORA_MS;
  return finBogotaMs - BOGOTA_OFFSET_MS;
}
