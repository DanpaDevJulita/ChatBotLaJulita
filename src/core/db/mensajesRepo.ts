import { supabase, supabaseConfigured } from "./supabase.js";

export type MensajeRole = "user" | "assistant" | "tool" | "system";

export interface Mensaje {
  id?: string;
  canal: string;
  external_id: string;
  role: MensajeRole;
  content: string;
  /** Qué agente generó este mensaje (solo aplica a role="assistant") — para trazabilidad
   *  y QA de qué agente respondió cada cosa, ver sección 12 del análisis. */
  agent_name?: string | null;
  created_at?: string;
}

/**
 * Guarda un mensaje en Supabase — no lanza error si falla (además de loguearlo), porque
 * el bot debe seguir respondiendo aunque el guardado del historial falle; no queremos
 * tumbar una conversación real de WhatsApp por un problema de base de datos.
 */
export async function insertMensaje(m: Mensaje): Promise<void> {
  if (!supabaseConfigured) return;
  const { error } = await supabase.from("mensajes").insert(m);
  if (error) console.error("[mensajesRepo] Error guardando mensaje:", error.message);
}

/** Historial de una conversación puntual (canal + external_id), del más viejo al más nuevo. */
export async function listMensajes(canal: string, externalId: string, limit = 200): Promise<Mensaje[]> {
  if (!supabaseConfigured) return [];
  // [2026-09-08] OJO con el orden: antes esto pedía los mensajes ascendentes con .limit(200),
  // es decir los 200 mensajes MÁS VIEJOS de la conversación. En un chat largo eso le daba al
  // bot el arranque de la charla y le escondía justo lo último que dijo el cliente. Ahora
  // pedimos los más NUEVOS (descendente + limit) y los devolvemos dados vuelta, para que
  // quien llama los siga recibiendo del más viejo al más nuevo.
  const { data, error } = await supabase
    .from("mensajes")
    .select("*")
    .eq("canal", canal)
    .eq("external_id", externalId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[mensajesRepo] Error leyendo mensajes:", error.message);
    return [];
  }
  return ((data ?? []) as Mensaje[]).reverse();
}

export interface ConversacionResumen {
  canal: string;
  external_id: string;
  ultimo_mensaje: string;
  ultimo_role: MensajeRole;
  ultima_actividad: string;
}

/** Lista de conversaciones (una fila por cliente) para el monitor del panel de administración. */
export async function listConversaciones(limit = 100): Promise<ConversacionResumen[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase.from("conversaciones").select("*").limit(limit);
  if (error) {
    console.error("[mensajesRepo] Error leyendo conversaciones:", error.message);
    return [];
  }
  return (data ?? []) as ConversacionResumen[];
}
