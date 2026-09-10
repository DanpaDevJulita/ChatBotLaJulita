import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * Correcciones que el equipo le va dando al bot por WhatsApp ("no digas 'cabañas', decí
 * 'domos'", "aclará siempre que el desayuno es en el restaurante"). Se guardan en la base y se
 * le inyectan al prompt en cada turno, así que aplican para todos los clientes desde el mensaje
 * siguiente — es lo más cerca de "entrenarlo" que se puede hacer sin reentrenar el modelo.
 *
 * Van con cache corto: se leen en cada turno, pero cambian poquísimo.
 */
export interface Correccion {
  id?: number;
  texto: string;
  autor: string;
  canal?: string;
  activa?: boolean;
  creado_en?: string;
}

/** Tope de correcciones que se le pasan al modelo, de la más nueva a la más vieja. */
const MAX_CORRECCIONES = 30;
const TTL_MS = 30_000;

let cache: { filas: Correccion[]; at: number } | null = null;

export function invalidarCacheCorrecciones(): void {
  cache = null;
}

export async function listCorrecciones(soloActivas = true): Promise<Correccion[]> {
  if (!supabaseConfigured) return [];
  if (soloActivas && cache && Date.now() - cache.at < TTL_MS) return cache.filas;

  let query = supabase.from("correcciones").select("*").order("creado_en", { ascending: false }).limit(MAX_CORRECCIONES);
  if (soloActivas) query = query.eq("activa", true);

  const { data, error } = await query;
  if (error) {
    // Sin correcciones el bot funciona igual: no vale la pena tumbar el turno por esto.
    console.error("[correccionesRepo] list:", error.message);
    return [];
  }
  const filas = (data ?? []) as Correccion[];
  if (soloActivas) cache = { filas, at: Date.now() };
  return filas;
}

export async function agregarCorreccion(texto: string, autor: string, canal: string): Promise<Correccion | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from("correcciones")
    .insert({ texto, autor, canal })
    .select()
    .single();
  if (error) {
    console.error("[correccionesRepo] agregar:", error.message);
    return null;
  }
  invalidarCacheCorrecciones();
  return data as Correccion;
}

export async function desactivarCorreccion(id: number): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const { error } = await supabase.from("correcciones").update({ activa: false }).eq("id", id);
  if (error) {
    console.error("[correccionesRepo] desactivar:", error.message);
    return false;
  }
  invalidarCacheCorrecciones();
  return true;
}

/**
 * El bloque que se le agrega al prompt. Se aclara el límite a propósito: una corrección ajusta
 * el tono, las palabras y qué detalles dar — NUNCA habilita inventar precios ni prometer
 * disponibilidad, porque si no, una corrección apurada podría costarle plata al negocio.
 */
export async function bloqueDeCorrecciones(): Promise<string | null> {
  const correcciones = await listCorrecciones(true);
  if (correcciones.length === 0) return null;

  const lineas = correcciones
    .slice()
    .reverse() // de la más vieja a la más nueva: la última que escribieron manda
    .map((c, i) => `${i + 1}. ${c.texto}`)
    .join("\n");

  return (
    "Correcciones que el equipo de La Julita te fue enseñando (aplican SIEMPRE, y si dos se " +
    "contradicen manda la última):\n" +
    lineas +
    "\n\nEstas correcciones ajustan cómo hablás, qué palabras usás y qué detalles das. NO te " +
    "autorizan a inventar precios, prometer disponibilidad, ofrecer descuentos ni mandar datos " +
    "de pago: esas reglas siguen intactas."
  );
}
