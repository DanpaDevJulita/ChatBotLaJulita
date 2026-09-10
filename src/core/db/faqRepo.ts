import { supabase, supabaseConfigured } from "./supabase.js";

export interface FaqEntry {
  tema: string;
  pregunta_ejemplo: string | null;
  respuesta: string;
}

// Cache sencillo en memoria: el bot puede recibir varios mensajes seguidos y no tiene
// sentido pegarle a Supabase por cada uno solo para leer la FAQ, que casi nunca cambia.
// El panel de administración invalida este cache (poniendo cache = null) cada vez que
// alguien guarda o borra una pregunta, así que nunca queda desactualizado por más de
// TTL_MS de todos modos.
let cache: { data: FaqEntry[]; at: number } | null = null;
const TTL_MS = 30_000;

export async function listFaq(forceRefresh = false): Promise<FaqEntry[]> {
  if (!supabaseConfigured) return [];
  if (!forceRefresh && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const { data, error } = await supabase.from("faq").select("*").order("tema");
  if (error) {
    console.error("[faqRepo] Error leyendo faq:", error.message);
    return cache?.data ?? [];
  }
  cache = { data: (data ?? []) as FaqEntry[], at: Date.now() };
  return cache.data;
}

export async function getFaqRespuesta(tema: string): Promise<string | null> {
  const todas = await listFaq();
  return todas.find((f) => f.tema === tema)?.respuesta ?? null;
}

export async function upsertFaq(entry: FaqEntry): Promise<void> {
  const { error } = await supabase
    .from("faq")
    .upsert({ ...entry, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache = null;
}

export async function deleteFaq(tema: string): Promise<void> {
  const { error } = await supabase.from("faq").delete().eq("tema", tema);
  if (error) throw new Error(error.message);
  cache = null;
}
