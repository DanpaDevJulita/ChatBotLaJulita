import { supabase, supabaseConfigured } from "./supabase.js";
import { alertarFalloTecnico } from "../pipeline/notificarDesarrollo.js";

/**
 * [2026-09-13] "Gateway Timeout" al leer el catálogo — pasó varias veces en producción
 * (ej. `[catalogoRepo:clase_domo] list: Gateway Timeout`).
 *
 * Qué es: Supabase contesta HTTP 504 cuando su puerta de entrada no alcanzó a recibir la
 * respuesta de la base a tiempo. No es un error de nuestras consultas ni de los datos: es un
 * momento malo (proyecto en plan gratuito despertando o con poca capacidad, o un tropiezo de red
 * entre la máquina donde corre el bot y Supabase). Casi siempre, el mismo pedido repetido un
 * segundo después funciona sin problema.
 *
 * Por qué importaba tanto: antes, una sola de estas fallas dejaba al bot SIN CATÁLOGO en ese
 * turno (la función devolvía una lista vacía), y con la lista vacía el cliente terminaba viendo
 * un "todavía no tengo los planes cargados" — un problema visible para el cliente por un hipo de
 * un segundo que nadie más notó.
 *
 * Qué hace esto: reintenta una vez (esperando un momento) y, si tampoco funciona, devuelve lo
 * ÚLTIMO que sí se pudo leer de esa misma consulta (el catálogo casi nunca cambia, así que el
 * dato de hace un minuto sirve perfecto). Solo si nunca se pudo leer nada devuelve vacío. En
 * todos los casos la falla queda en los logs y dispara el aviso técnico al equipo.
 */
const ultimoDatoBueno = new Map<string, unknown[]>();

async function leerCatalogo<T>(params: {
  /** Identifica la consulta en los logs y en el aviso técnico, ej. "planes". */
  etiqueta: string;
  /** Distingue variantes de la misma tabla (ej. solo activos vs. todos) para el dato de respaldo. */
  clave: string;
  consulta: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}): Promise<T[]> {
  const { etiqueta, clave, consulta } = params;

  for (let intento = 1; intento <= 2; intento++) {
    const { data, error } = await consulta();

    if (!error) {
      const filas = (data ?? []) as T[];
      ultimoDatoBueno.set(clave, filas as unknown[]);
      return filas;
    }

    if (intento === 1) {
      console.warn(`[catalogoRepo:${etiqueta}] ${error.message} — reintento en 400 ms.`);
      await new Promise((listo) => setTimeout(listo, 400));
      continue;
    }

    // Segundo intento fallido: se avisa al equipo y se usa el último dato bueno si existe.
    console.error(`[catalogoRepo:${etiqueta}] list: ${error.message}`);
    void alertarFalloTecnico({
      clave: `catalogo:${etiqueta}`,
      titulo: `Supabase: no se pudo leer ${etiqueta} (falló dos veces seguidas)`,
      detalle: error.message,
    });

    const respaldo = ultimoDatoBueno.get(clave) as T[] | undefined;
    if (respaldo) {
      console.warn(
        `[catalogoRepo:${etiqueta}] uso el último dato bueno (${respaldo.length} fila(s)) para no ` +
          "dejar al cliente sin catálogo."
      );
      return respaldo;
    }
  }

  return [];
}

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
    return leerCatalogo<Plan>({
      etiqueta: "planes",
      clave: `planes:${soloActivos ? "activos" : "todos"}`,
      consulta: () => {
        let query = supabase.from("planes").select("*").order("id", { ascending: true });
        if (soloActivos) query = query.eq("activo", true);
        return query;
      },
    });
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
  // [2026-09-13] Las dos lecturas pasan por leerCatalogo: con un "Gateway Timeout" de Supabase
  // se reintenta y, si no, se usa el último dato bueno — antes un 504 acá dejaba al bot sin
  // domos/clases y el cliente veía "todavía no tengo los planes cargados" (ver leerCatalogo).
  const [domos, clases] = await Promise.all([
    leerCatalogo<Domo>({
      etiqueta: "domos",
      clave: "domos",
      consulta: () => supabase.from("domos").select("*").order("id", { ascending: true }),
    }),
    leerCatalogo<ClaseDomo>({
      etiqueta: "clase_domo",
      clave: "clase_domo",
      consulta: () => supabase.from("clase_domo").select("*").order("id", { ascending: true }),
    }),
  ]);
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
    return leerCatalogo<Adicional>({
      etiqueta: "adicionales",
      clave: `adicionales:${soloActivos ? "activos" : "todos"}`,
      consulta: () => {
        let query = supabase.from("adicionales").select("*").order("id", { ascending: true });
        if (soloActivos) query = query.eq("estado", true);
        return query;
      },
    });
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
  return leerCatalogo<TipoAdicional>({
    etiqueta: "tipo_adicional",
    clave: "tipo_adicional",
    consulta: () => supabase.from("tipo_adicional").select("*").order("id", { ascending: true }),
  });
}

// Configuración general (horarios de check-in/check-out, y lo que se agregue después) ----
export async function getConfiguracion(): Promise<Record<string, string>> {
  if (!supabaseConfigured) return {};
  // Los horarios de check-in/check-out salen de acá y se le muestran al cliente: si un 504 los
  // dejaba vacíos, el bot contestaba "todavía no tengo los horarios cargados". Con leerCatalogo
  // se reintenta y, si no, se usa lo último bueno.
  const filas = await leerCatalogo<{ clave: string; valor: string }>({
    etiqueta: "configuracion",
    clave: "configuracion",
    consulta: () => supabase.from("configuracion").select("*"),
  });
  return Object.fromEntries(filas.map((r) => [r.clave, r.valor]));
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
