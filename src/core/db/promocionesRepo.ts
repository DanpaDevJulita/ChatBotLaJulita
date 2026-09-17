import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * [2026-09-15] Módulo de promociones — ver sql/promociones.sql y
 * REFERENCIA-MODULO-PROMOCIONES.md. A diferencia de `planes`, una promoción es contenido
 * PROPIO (foto + texto corto + botón): no depende de que exista un plan cargado, porque puede
 * ser un combo o una oferta que no es ninguno de los planes normales. Se muestra SOLO por el
 * carrusel de WhatsApp, y SOLO cuando el equipo dispara la campaña a mano desde el panel — el
 * bot nunca la manda solo durante una conversación normal (decisión de Daniel, 2026-09-15).
 */
export interface Promocion {
  id?: number;
  nombre: string;
  texto_tarjeta: string;
  imagen_url: string;
  boton_texto?: string;
  boton_url?: string | null;
  orden?: number;
  activa?: boolean;
}

export const promocionesRepo = {
  async list(soloActivas = false): Promise<Promocion[]> {
    if (!supabaseConfigured) return [];
    let query = supabase.from("promociones").select("*").order("orden", { ascending: true }).order("id", { ascending: true });
    if (soloActivas) query = query.eq("activa", true);
    const { data, error } = await query;
    if (error) {
      console.error("[promocionesRepo] list:", error.message);
      return [];
    }
    return (data ?? []) as Promocion[];
  },

  async upsert(row: Promocion): Promise<Promocion> {
    const { data, error } = await supabase.from("promociones").upsert(row).select().single();
    if (error) throw new Error(error.message);
    return data as Promocion;
  },

  async remove(id: number): Promise<void> {
    const { error } = await supabase.from("promociones").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
};

/**
 * Plantillas de carousel ya aprobadas por Meta/YCloud, registradas a mano desde el panel
 * después de la aprobación (ver REFERENCIA-CAROUSEL-WHATSAPP.md). El código las usa para saber
 * cuál plantilla corresponde según cuántas promociones estén activas — WhatsApp exige que el
 * número de tarjetas del envío sea EXACTO al que se aprobó.
 */
export interface PlantillaCarousel {
  id?: number;
  nombre_plantilla: string;
  idioma?: string;
  cantidad_tarjetas: number;
  incluye_boton_url?: boolean;
  activa?: boolean;
}

export const plantillasCarouselRepo = {
  async list(soloActivas = false): Promise<PlantillaCarousel[]> {
    if (!supabaseConfigured) return [];
    let query = supabase.from("plantillas_carousel").select("*").order("cantidad_tarjetas", { ascending: true });
    if (soloActivas) query = query.eq("activa", true);
    const { data, error } = await query;
    if (error) {
      console.error("[promocionesRepo] plantillasCarouselRepo.list:", error.message);
      return [];
    }
    return (data ?? []) as PlantillaCarousel[];
  },

  async upsert(row: PlantillaCarousel): Promise<PlantillaCarousel> {
    const { data, error } = await supabase.from("plantillas_carousel").upsert(row).select().single();
    if (error) throw new Error(error.message);
    return data as PlantillaCarousel;
  },

  async remove(id: number): Promise<void> {
    const { error } = await supabase.from("plantillas_carousel").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
};

/** Una fila del historial de campañas — ver promociones_envios en sql/promociones.sql. */
export interface EnvioPromocion {
  id?: number;
  plantilla_nombre: string;
  promocion_ids: number[];
  total_destinatarios: number;
  total_exitosos: number;
  total_fallidos: number;
  detalle_fallidos: { destinatario: string; error: string }[];
}

export async function registrarEnvioPromocion(envio: EnvioPromocion): Promise<void> {
  if (!supabaseConfigured) return;
  const { error } = await supabase.from("promociones_envios").insert(envio as any);
  if (error) console.error("[promocionesRepo] registrarEnvioPromocion:", error.message);
}

export async function listEnviosPromociones(limite = 20): Promise<EnvioPromocion[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from("promociones_envios")
    .select("*")
    .order("creado_en", { ascending: false })
    .limit(limite);
  if (error) {
    console.error("[promocionesRepo] listEnviosPromociones:", error.message);
    return [];
  }
  return (data ?? []) as EnvioPromocion[];
}
