import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * Estado del orquestador por conversación: qué agente la atendió por última vez (para la
 * "pegajosidad" — no reclasificar a ciegas cada turno), un resumen corto (todavía no
 * implementado; `resumen` queda reservado en el schema para cuando se porte `summarizer.ts`
 * de `agente-ycloud-main`), y desde [2026-09-10] si la conversación está escalada a una
 * persona del equipo (ver sql/escalamiento-humano.sql y src/core/pipeline/notificarEquipo.ts).
 */
export interface EstadoConversacion {
  canal: string;
  external_id: string;
  last_agent: string | null;
  resumen: string | null;
  /** NULL = no escalada. Con fecha = esperando a una persona del equipo desde ese momento. */
  escalado_en: string | null;
  /** Última vez que se le confirmó al CLIENTE "seguís con el equipo" (para no repetirlo en cada mensaje). */
  ultimo_aviso_humano_en: string | null;
  /**
   * [2026-09-13] La última reserva que ESTA conversación registró (ver sql/reserva-activa.sql).
   * Fuente de verdad para los pasos de pago: por encima de cualquier reserva_id que el modelo
   * mande, para que un cliente nunca pueda terminar pagando la reserva de otro. Ver
   * conversacionActivaRepo.ts para el porqué completo.
   */
  reserva_activa_id: number | null;
  reserva_activa_en: string | null;
}

function vacio(canal: string, externalId: string): EstadoConversacion {
  return {
    canal,
    external_id: externalId,
    last_agent: null,
    resumen: null,
    escalado_en: null,
    ultimo_aviso_humano_en: null,
    reserva_activa_id: null,
    reserva_activa_en: null,
  };
}

export async function getEstado(canal: string, externalId: string): Promise<EstadoConversacion> {
  if (!supabaseConfigured) return vacio(canal, externalId);

  const { data, error } = await supabase
    .from("estado_conversacion")
    .select("*")
    .eq("canal", canal)
    .eq("external_id", externalId)
    .maybeSingle();

  if (error) {
    console.error("[estadoRepo] getEstado:", error.message);
    return vacio(canal, externalId);
  }
  return (data as EstadoConversacion | null) ?? vacio(canal, externalId);
}

export async function setLastAgent(canal: string, externalId: string, lastAgent: string): Promise<void> {
  if (!supabaseConfigured) return;

  const { error } = await supabase
    .from("estado_conversacion")
    .upsert({ canal, external_id: externalId, last_agent: lastAgent, updated_at: new Date().toISOString() });

  if (error) console.error("[estadoRepo] setLastAgent:", error.message);
}

/**
 * [2026-09-10] Marca la conversación como escalada (primera vez que el orquestador manda a
 * "humano" en esta racha). Idempotente: si ya estaba escalada no pisa la fecha original, así
 * `escalado_en` siempre refleja desde cuándo espera el cliente — no desde su último mensaje.
 */
export async function marcarEscalado(canal: string, externalId: string): Promise<void> {
  if (!supabaseConfigured) return;
  const actual = await getEstado(canal, externalId);
  if (actual.escalado_en) return; // ya estaba escalada: no tocar la fecha original.

  const { error } = await supabase
    .from("estado_conversacion")
    .upsert({
      canal,
      external_id: externalId,
      last_agent: "humano",
      escalado_en: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("[estadoRepo] marcarEscalado:", error.message);
}

export async function marcarAvisoHumano(canal: string, externalId: string): Promise<void> {
  if (!supabaseConfigured) return;
  const { error } = await supabase
    .from("estado_conversacion")
    .update({ ultimo_aviso_humano_en: new Date().toISOString() })
    .eq("canal", canal)
    .eq("external_id", externalId);

  if (error) console.error("[estadoRepo] marcarAvisoHumano:", error.message);
}

/**
 * [2026-09-13] Anota qué reserva quedó activa en esta conversación, justo después de que
 * `registrar_datos_reserva` la crea con éxito. Vive en la BASE (no en memoria del proceso) a
 * propósito: con varios procesos del bot corriendo a la vez (o uno solo que se reinicia),
 * cualquiera de ellos tiene que poder leer este dato — no solo el que atendió el registro.
 */
export async function marcarReservaActiva(canal: string, externalId: string, reservaId: number): Promise<void> {
  if (!supabaseConfigured) return;

  const { error } = await supabase
    .from("estado_conversacion")
    .upsert({
      canal,
      external_id: externalId,
      reserva_activa_id: reservaId,
      reserva_activa_en: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("[estadoRepo] marcarReservaActiva:", error.message);
}

/**
 * [2026-09-10] Todas las conversaciones de un canal que están escaladas ahora mismo — para que
 * `/resuelto <numero>` (ver comandos.ts) pueda encontrar el `external_id` exacto buscando por
 * los últimos dígitos, igual que ya hace `/confirmar` con los bloqueos pendientes.
 */
export async function conversacionesEscaladas(canal: string): Promise<{ external_id: string; escalado_en: string }[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from("estado_conversacion")
    .select("external_id, escalado_en")
    .eq("canal", canal)
    .not("escalado_en", "is", null);

  if (error) {
    console.error("[estadoRepo] conversacionesEscaladas:", error.message);
    return [];
  }
  return (data ?? []) as { external_id: string; escalado_en: string }[];
}

/**
 * [2026-09-10] El equipo ya resolvió el caso (comando `/resuelto <numero>`, ver comandos.ts):
 * se limpia el escalamiento y se resetea `last_agent` para que el próximo mensaje del cliente
 * lo reclasifique el orquestador desde cero, en vez de quedar pegado a "humano" para siempre.
 */
export async function resolverEscalamiento(canal: string, externalId: string): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const { error } = await supabase
    .from("estado_conversacion")
    .update({ last_agent: null, escalado_en: null, ultimo_aviso_humano_en: null })
    .eq("canal", canal)
    .eq("external_id", externalId);

  if (error) {
    console.error("[estadoRepo] resolverEscalamiento:", error.message);
    return false;
  }
  return true;
}
