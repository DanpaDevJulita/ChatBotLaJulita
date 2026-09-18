import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * [2026-09-13] Las políticas oficiales del glamping, leídas de la tabla `politicas`
 * (ver sql/politicas.sql, que trae la tabla y el contenido oficial).
 *
 * La base es la ÚNICA fuente: acá no hay ningún texto de respaldo escrito a mano a propósito.
 * Este proyecto ya se quemó con eso — el bug de precios del 2026-09-11 fue exactamente un dato
 * escrito en dos lugares (la columna y, a mano, la descripción del plan), y el cliente terminó
 * viendo el valor viejo (ver PENDIENTE-precios.md). Con condiciones comerciales el riesgo es
 * peor: si el equipo cambia un plazo en la base y el código tiene una copia vieja, el bot le
 * promete al cliente algo que el negocio ya no cumple. Si la tabla no responde, el bot dice que
 * lo confirma con el equipo — igual que hace con los planes cuando la base viene vacía.
 */
export interface Politica {
  clave: string;
  titulo: string | null;
  contenido: string;
  activo?: boolean;
}

/**
 * Las claves que el código conoce. Tienen que existir en la tabla (las siembra el .sql).
 *
 * [2026-09-17] `presentacion_general` no es una condición comercial como las otras cuatro: es el
 * texto de presentación del glamping, el que se manda cuando alguien pregunta precios sin decir
 * fecha ni cuántas personas (ver sql/presentacion-general.sql y la herramienta
 * `presentar_glamping`). Vive en esta misma tabla para no crear una tabla nueva por una sola
 * fila, y porque acá ya hay cache y edición desde el panel. `consultar_politicas` no la devuelve
 * nunca: esa herramienta mapea sus temas solo a las cuatro claves de condiciones.
 *
 * [2026-09-18] `saludo_bienvenida` es el mensaje con el que arranca TODA conversación nueva, el
 * que trae el aviso de la política de datos. Lo manda el pipeline antes de atender el primer
 * mensaje (ver saludarSiEsElPrimerMensaje en core/pipeline/runTurn.ts), no el modelo, y vive acá
 * para que el equipo lo pueda cambiar desde el panel. Es la única clave con copia de respaldo en
 * el código: sin ella, una caída de la base dejaría al cliente sin el aviso legal.
 */
export type ClavePolitica =
  | "terminos_reserva"
  | "antes_de_reservar"
  | "saldo_pendiente"
  | "cambios_corta"
  | "presentacion_general"
  | "saludo_bienvenida";

// Mismo cache que faqRepo: el bot puede recibir varios mensajes seguidos y estos textos casi
// nunca cambian. 30 segundos alcanza para que una edición del equipo se vea casi enseguida.
let cache: { data: Politica[]; at: number } | null = null;
const TTL_MS = 30_000;

/** Vacía el cache. Lo usa el panel de administración al guardar, y las pruebas entre casos. */
export function invalidarCachePoliticas(): void {
  cache = null;
}

export async function listPoliticas(forceRefresh = false): Promise<Politica[]> {
  if (!supabaseConfigured) return [];
  if (!forceRefresh && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const { data, error } = await supabase.from("politicas").select("*").order("clave");
  if (error) {
    // Si la consulta falla nos quedamos con lo último que sí leímos: es mejor una política de
    // hace un minuto que ninguna. Si nunca leímos nada, devuelve vacío y quien llama decide.
    console.error("[politicasRepo] Error leyendo politicas:", error.message);
    return cache?.data ?? [];
  }
  cache = { data: (data ?? []) as Politica[], at: Date.now() };
  return cache.data;
}

/**
 * El texto de una política. Devuelve null si no está cargada, si está desactivada, o si la base
 * no responde — quien llama NUNCA debe inventar un reemplazo.
 */
export async function politica(clave: ClavePolitica): Promise<string | null> {
  const todas = await listPoliticas();
  const fila = todas.find((p) => p.clave === clave);
  if (!fila || fila.activo === false) return null;
  const texto = (fila.contenido ?? "").trim();
  return texto.length > 0 ? texto : null;
}

/**
 * Varias políticas de una, en el orden pedido y sin las que falten. Útil para armar el bloque
 * del mensaje de pago (saldo + cambios) sin tener que encadenar ifs en quien llama.
 */
export async function politicasUnidas(claves: ClavePolitica[], separador = "\n"): Promise<string | null> {
  const textos: string[] = [];
  for (const clave of claves) {
    const texto = await politica(clave);
    if (texto) textos.push(texto);
  }
  return textos.length > 0 ? textos.join(separador) : null;
}

export async function upsertPolitica(entry: Politica): Promise<void> {
  const { error } = await supabase
    .from("politicas")
    .upsert({ ...entry, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache = null;
}

export async function deletePolitica(clave: string): Promise<void> {
  const { error } = await supabase.from("politicas").delete().eq("clave", clave);
  if (error) throw new Error(error.message);
  cache = null;
}
