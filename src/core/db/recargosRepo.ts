import { supabase, supabaseConfigured } from "./supabase.js";
import { alertarFalloTecnico } from "../pipeline/notificarDesarrollo.js";

/**
 * [2026-09-14] Recargos: lo que se cobra APARTE del plan — hoy niños por rango de edad y
 * mascotas. Ver sql/recargos.sql para el porqué completo.
 *
 * Resumen: esos valores vivían escritos a mano dentro de la descripción de algunos planes, y como
 * no existían en ninguna columna, el bot los borraba antes de escribirle al cliente (no puede
 * mandar una cifra que no pueda verificar). El cliente se enteraba del recargo por su hijo al
 * llegar al glamping. Ahora el dato es real y el bot lo puede decir.
 */
export interface Recargo {
  id?: number;
  tipo: "nino" | "mascota";
  nombre: string;
  descripcion?: string | null;
  precio: number;
  edad_min?: number | null;
  edad_max?: number | null;
  plan_id?: number | null;
  activo?: boolean;
}

export const recargosRepo = {
  /** Los recargos activos, opcionalmente de un tipo. Ordenados por edad para que se lean solos. */
  async list(tipo?: "nino" | "mascota"): Promise<Recargo[]> {
    if (!supabaseConfigured) return [];

    let query = supabase.from("recargos").select("*").eq("activo", true);
    if (tipo) query = query.eq("tipo", tipo);

    const { data, error } = await query;
    if (error) {
      console.error("[recargosRepo] list:", error.message);
      void alertarFalloTecnico({
        clave: "catalogo:recargos",
        titulo: "Supabase: no se pudo leer la tabla recargos",
        detalle: error.message,
      });
      return [];
    }

    const filas = (data ?? []) as Recargo[];
    return filas.sort((a, b) => {
      if (a.tipo !== b.tipo) return a.tipo.localeCompare(b.tipo);
      return (a.edad_min ?? 0) - (b.edad_min ?? 0);
    });
  },

  async upsert(row: Recargo): Promise<Recargo> {
    const { data, error } = await supabase
      .from("recargos")
      .upsert({ ...row, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data as Recargo;
  },

  async remove(id: number): Promise<void> {
    const { error } = await supabase.from("recargos").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
};

/**
 * El recargo que le corresponde a un niño de `edad` años, o null si a esa edad no se cobra nada
 * (los más chiquitos) o si todavía no hay recargos cargados.
 *
 * Se elige el rango MÁS ESPECÍFICO que contenga la edad; entre varios que apliquen, el de edad
 * mínima más alta (el más ajustado). Así, si mañana alguien carga rangos que se solapan, el bot
 * no contesta cualquiera de los dos al azar.
 */
export function recargoParaEdad(recargos: Recargo[], edad: number): Recargo | null {
  const candidatos = recargos
    .filter((r) => r.tipo === "nino")
    .filter((r) => edad >= (r.edad_min ?? 0) && edad <= (r.edad_max ?? 200));

  if (candidatos.length === 0) return null;
  return candidatos.sort((a, b) => (b.edad_min ?? 0) - (a.edad_min ?? 0))[0];
}
