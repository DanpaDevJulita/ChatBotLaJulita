import { supabase, supabaseConfigured } from "./supabase.js";

// Planes -----------------------------------------------------------------------------------
// Forma real de la tabla `planes` (rediseño del 2026-09-04, ver sql/schema.sql PARTE 2):
// id serial, tres precios según el día (no un solo "precio" como antes), domos_id es un
// arreglo de ids de `domos` (validado por trigger en la base de datos, no aquí).
export interface Plan {
  id?: number;
  nombre: string;
  descripcion?: string | null;
  precio_entre_semana?: number | null;
  precio_fin_de_semana?: number | null;
  precio_fin_de_semana_puente?: number | null;
  // OJO: NO hay columna `capacidad` en `planes` (se quitó en el rediseño). La capacidad
  // sale del nombre del plan y de `domos.capacidad_max` — ver capacidadDePlan() en
  // src/agentes/ventas/herramientas/planes.ts. Pedirla en un select falla con 42703.
  domos_id?: number[] | null;
  activo?: boolean;
}

export const planesRepo = {
  async list(soloActivos = false): Promise<Plan[]> {
    if (!supabaseConfigured) return [];
    let query = supabase.from("planes").select("*").order("id", { ascending: true });
    if (soloActivos) query = query.eq("activo", true);
    const { data, error } = await query;
    if (error) {
      console.error("[catalogoRepo:planes] list:", error.message);
      return [];
    }
    return (data ?? []) as Plan[];
  },

  async upsert(row: Plan): Promise<Plan> {
    const { data, error } = await supabase.from("planes").upsert(row).select().single();
    if (error) throw new Error(error.message);
    return data as Plan;
  },

  async remove(id: number): Promise<void> {
    const { error } = await supabase.from("planes").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
};

// Domos y sus clases -----------------------------------------------------------------------
// `planes.domos_id` es un arreglo de ids de `domos`, y cada domo tiene su `clase` (chalet,
// clásico, deluxe...) y su `capacidad_max`. Con eso el bot puede mostrarle al cliente planes
// de tipos de alojamiento distintos y filtrar por cuántas personas son, en vez de mandarle
// los 20 planes de una sola vez. Son tablas chicas que casi nunca cambian: van con cache.
export interface ClaseDomo {
  id?: number;
  nombre: string;
}

export interface Domo {
  id?: number;
  clase: number;
  opcion?: string | null;
  capacidad_max: number;
}

let cacheDomos: { domos: Domo[]; clases: ClaseDomo[]; at: number } | null = null;
const TTL_DOMOS_MS = 60_000;

export async function getDomosYClases(): Promise<{ domos: Domo[]; clases: ClaseDomo[] }> {
  if (!supabaseConfigured) return { domos: [], clases: [] };
  if (cacheDomos && Date.now() - cacheDomos.at < TTL_DOMOS_MS) {
    return { domos: cacheDomos.domos, clases: cacheDomos.clases };
  }
  const [resDomos, resClases] = await Promise.all([
    supabase.from("domos").select("*").order("id", { ascending: true }),
    supabase.from("clase_domo").select("*").order("id", { ascending: true }),
  ]);
  if (resDomos.error) console.error("[catalogoRepo:domos] list:", resDomos.error.message);
  if (resClases.error) console.error("[catalogoRepo:clase_domo] list:", resClases.error.message);
  const domos = (resDomos.data ?? []) as Domo[];
  const clases = (resClases.data ?? []) as ClaseDomo[];
  cacheDomos = { domos, clases, at: Date.now() };
  return { domos, clases };
}

// Adicionales --------------------------------------------------------------------------------
// Forma real de la tabla `adicionales` (rediseño del 2026-09-04, ver sql/schema.sql PARTE 3):
// id serial, la columna de activo/inactivo se llama `estado` (no `activo`, a diferencia de
// `planes`), y `tipo_adicional_id` referencia la tabla `tipo_adicional`.
export interface Adicional {
  id?: number;
  nombre: string;
  descripcion?: string | null;
  precio?: number | null;
  tipo_adicional_id: number;
  estado?: boolean;
}

export const adicionalesRepo = {
  async list(soloActivos = false): Promise<Adicional[]> {
    if (!supabaseConfigured) return [];
    let query = supabase.from("adicionales").select("*").order("id", { ascending: true });
    if (soloActivos) query = query.eq("estado", true);
    const { data, error } = await query;
    if (error) {
      console.error("[catalogoRepo:adicionales] list:", error.message);
      return [];
    }
    return (data ?? []) as Adicional[];
  },

  async upsert(row: Adicional): Promise<Adicional> {
    const { data, error } = await supabase.from("adicionales").upsert(row).select().single();
    if (error) throw new Error(error.message);
    return data as Adicional;
  },

  async remove(id: number): Promise<void> {
    const { error } = await supabase.from("adicionales").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
};

// Tipos de adicional (SPA, DECORACION, ...) — catálogo chico, solo lectura desde el panel.
export interface TipoAdicional {
  id?: number;
  nombre: string;
}

export async function listTipoAdicional(): Promise<TipoAdicional[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase.from("tipo_adicional").select("*").order("id", { ascending: true });
  if (error) {
    console.error("[catalogoRepo:tipo_adicional] list:", error.message);
    return [];
  }
  return (data ?? []) as TipoAdicional[];
}

// Configuración general (horarios de check-in/check-out, y lo que se agregue después) ----
export async function getConfiguracion(): Promise<Record<string, string>> {
  if (!supabaseConfigured) return {};
  const { data, error } = await supabase.from("configuracion").select("*");
  if (error) {
    console.error("[catalogoRepo] getConfiguracion:", error.message);
    return {};
  }
  return Object.fromEntries((data ?? []).map((r: any) => [r.clave, r.valor]));
}

export async function setConfiguracion(clave: string, valor: string): Promise<void> {
  const { error } = await supabase
    .from("configuracion")
    .upsert({ clave, valor, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

// Fechas bloqueadas / no disponibles ------------------------------------------------------
export interface FechaBloqueada {
  id?: string;
  fecha: string; // YYYY-MM-DD
  motivo?: string | null;
}

export async function listFechasBloqueadas(desde?: string): Promise<FechaBloqueada[]> {
  if (!supabaseConfigured) return [];
  let query = supabase.from("fechas_bloqueadas").select("*").order("fecha", { ascending: true });
  if (desde) query = query.gte("fecha", desde);
  const { data, error } = await query;
  if (error) {
    console.error("[catalogoRepo] listFechasBloqueadas:", error.message);
    return [];
  }
  return (data ?? []) as FechaBloqueada[];
}

export async function addFechaBloqueada(fecha: string, motivo?: string): Promise<void> {
  const { error } = await supabase.from("fechas_bloqueadas").upsert({ fecha, motivo });
  if (error) throw new Error(error.message);
}

export async function removeFechaBloqueada(id: string): Promise<void> {
  const { error } = await supabase.from("fechas_bloqueadas").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
