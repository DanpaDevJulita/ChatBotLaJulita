import { supabase } from "./supabase.js";

export interface PermisosNumero {
  nombre: string;
  puedeReportar: boolean;
  puedeEnsenar: boolean;
}

// One-minute cache for permission lookups
const permisosCache = new Map<
  string,
  { permisos: PermisosNumero | null; timestamp: number }
>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * Extracts the last 10 digits from a phone number.
 * This matches the generated column logic in the database.
 */
function extraerCelularClave(numero: string): string {
  const digitos = numero.replace(/\D/g, ""); // Remove non-digits
  return digitos.slice(-10); // Last 10 digits
}

/**
 * Looks up user permissions by phone number.
 * First tries the panel's users table via Supabase.
 * Uses one-minute cache to reduce database queries.
 * Returns null on error (caller should fall back to .env).
 */
export async function permisosDeNumero(
  numeroWhatsApp: string
): Promise<PermisosNumero | null> {
  try {
    const clave = extraerCelularClave(numeroWhatsApp);

    // Check cache first
    const cached = permisosCache.get(clave);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.permisos;
    }

    // Query the users table in the panel's LaJulitaWeb schema
    // Column names: celular_clave (generated), activo, bot_puede_corregir
    const { data, error } = await supabase
      .from("users") // Table in LaJulitaWeb's Supabase
      .select("id, nombre:name, activo, bot_puede_corregir")
      .eq("celular_clave", clave)
      .eq("activo", true)
      .eq("bot_puede_corregir", true)
      .single(); // Expect at most one match

    if (error) {
      // If it's a "not found" error, return null (not authorized)
      if (error.code === "PGRST116") {
        const permisos = null;
        permisosCache.set(clave, { permisos, timestamp: Date.now() });
        return permisos;
      }

      // Other errors: log and return null (will fall back to .env)
      console.error(
        `Error querying permissions for ${clave}:`,
        error.message
      );
      return null;
    }

    // User found with both activo=true and bot_puede_corregir=true
    const permisos: PermisosNumero = {
      nombre: data.nombre || "Usuario Panel",
      puedeReportar: true,
      puedeEnsenar: true,
    };

    permisosCache.set(clave, { permisos, timestamp: Date.now() });
    return permisos;
  } catch (err) {
    console.error("Unexpected error in permisosDeNumero:", err);
    return null; // Fall back to .env
  }
}

/**
 * Clears the cache for a specific phone number (useful for testing).
 */
export function olvidarCachePermisos(numeroWhatsApp: string): void {
  const clave = extraerCelularClave(numeroWhatsApp);
  permisosCache.delete(clave);
  console.log(`Cache cleared for ${clave}`);
}

/**
 * Clears all cache (useful for testing).
 */
export function olvidarTodoCache(): void {
  permisosCache.clear();
  console.log("All permission cache cleared");
}
