import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * Estado del orquestador por conversación: qué agente la atendió por última vez (para la
 * "pegajosidad" — no reclasificar a ciegas cada turno) y, más adelante, un resumen corto
 * (todavía no implementado; `resumen` queda reservado en el schema para cuando se porte
 * `summarizer.ts` de `agente-ycloud-main`).
 */
export interface EstadoConversacion {
  canal: string;
  external_id: string;
  last_agent: string | null;
  resumen: string | null;
}

function vacio(canal: string, externalId: string): EstadoConversacion {
  return { canal, external_id: externalId, last_agent: null, resumen: null };
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
