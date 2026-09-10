/**
 * Formato de fechas para hablarle al cliente. Se calcula en UTC a propósito: las fechas del bot
 * son fechas "de calendario" (AAAA-MM-DD, el día de la estadía), no instantes — si se
 * interpretaran en la zona local podrían correrse un día.
 */

/** "2026-12-20" -> "sábado 20 de diciembre de 2026" */
export function fechaLarga(fechaISO: string): string {
  const d = aDate(fechaISO);
  if (!d) return fechaISO;
  return d.toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-12-20" -> "sábado 20 de diciembre" (sin año: para listas de fechas cercanas) */
export function fechaCorta(fechaISO: string): string {
  const d = aDate(fechaISO);
  if (!d) return fechaISO;
  return d.toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function aDate(fechaISO: string): Date | null {
  const m = (fechaISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}
