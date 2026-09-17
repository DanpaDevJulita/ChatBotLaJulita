import { Database } from "@/types/supabase.js";
import { supabase } from "./supabase.js";

export interface PermisosNumero {
  nombre: string;
  puedeReportar: boolean;
  puedeEnsenar: boolean;
}

/**
 * Abre un ticket de falla reportada por un usuario autorizado.
 * Cada reporte es registrado como una entrada nueva (sin deduplicación).
 */
export async function abrirTicketReportado(
  texto: string,
  reportadoPor: string,
  canal: "whatsapp" | "sms" | "telegram",
  externalId: string,
  medio: "texto" | "audio"
): Promise<{ id?: number; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("tickets")
      .insert([
        {
          entrada: texto,
          reportado_por: reportadoPor,
          canal: canal,
          external_id: externalId,
          origen: "reporte", // enum: 'tecnico' | 'reportado' | 'ensenanza'
          estado: "abierto",
          medio_entrada: medio, // nuevo campo: 'texto' | 'audio'
          created_at: new Date().toISOString(),
        },
      ])
      .select("id")
      .single();

    if (error) {
      console.error("Error creating reportado ticket:", error);
      // Si el error es sobre 'origen' constraint, fallback sin marcar el origen
      if (
        error.code === "23514" ||
        error.message.includes("origen")
      ) {
        console.warn(
          "origen constraint issue, retrying without explicit origin..."
        );
        const { data: data2, error: error2 } = await supabase
          .from("tickets")
          .insert([
            {
              entrada: texto,
              reportado_por: reportadoPor,
              canal: canal,
              external_id: externalId,
              estado: "abierto",
              medio_entrada: medio,
              created_at: new Date().toISOString(),
            },
          ])
          .select("id")
          .single();

        if (error2) {
          return { error: error2.message };
        }
        return { id: data2?.id };
      }
      return { error: error.message };
    }

    return { id: data?.id };
  } catch (err) {
    console.error("Unexpected error in abrirTicketReportado:", err);
    return { error: String(err) };
  }
}

/**
 * Abre un ticket de enseñanza (teaching/correction history).
 * Este ticket queda en estado 'resuelto' desde el inicio, con un link
 * a la corrección guardada via clave_bot: `aprende:<correccionId>`
 */
export async function abrirTicketEnsenanza(
  entrada: string,
  reportadoPor: string,
  correccionId: number,
  canal: "whatsapp" | "sms" | "telegram" = "whatsapp"
): Promise<{ id?: number; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("tickets")
      .insert([
        {
          entrada: entrada,
          reportado_por: reportadoPor,
          canal: canal,
          origen: "ensenanza",
          estado: "resuelto",
          clave_bot: `aprende:${correccionId}`,
          created_at: new Date().toISOString(),
        },
      ])
      .select("id")
      .single();

    if (error) {
      console.error("Error creating ensenanza ticket:", error);
      if (error.code === "23514" || error.message.includes("origen")) {
        console.warn(
          "origen constraint issue, retrying without explicit origin..."
        );
        const { data: data2, error: error2 } = await supabase
          .from("tickets")
          .insert([
            {
              entrada: entrada,
              reportado_por: reportadoPor,
              canal: canal,
              estado: "resuelto",
              clave_bot: `aprende:${correccionId}`,
              created_at: new Date().toISOString(),
            },
          ])
          .select("id")
          .single();

        if (error2) {
          return { error: error2.message };
        }
        return { id: data2?.id };
      }
      return { error: error.message };
    }

    return { id: data?.id };
  } catch (err) {
    console.error("Unexpected error in abrirTicketEnsenanza:", err);
    return { error: String(err) };
  }
}

/**
 * Abre un ticket técnico (para errores del sistema del bot).
 * Mantiene la interfaz anterior para compatibilidad.
 */
export async function abrirTicketTecnico(
  entrada: string,
  reportadoPor?: string
): Promise<{ id?: number; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("tickets")
      .insert([
        {
          entrada: entrada,
          reportado_por: reportadoPor || "bot_interno",
          canal: "interno",
          origen: "tecnico",
          estado: "abierto",
          created_at: new Date().toISOString(),
        },
      ])
      .select("id")
      .single();

    if (error) {
      console.error("Error creating tecnico ticket:", error);
      if (error.code === "23514" || error.message.includes("origen")) {
        const { data: data2, error: error2 } = await supabase
          .from("tickets")
          .insert([
            {
              entrada: entrada,
              reportado_por: reportadoPor || "bot_interno",
              canal: "interno",
              estado: "abierto",
              created_at: new Date().toISOString(),
            },
          ])
          .select("id")
          .single();

        if (error2) {
          return { error: error2.message };
        }
        return { id: data2?.id };
      }
      return { error: error.message };
    }

    return { id: data?.id };
  } catch (err) {
    console.error("Unexpected error in abrirTicketTecnico:", err);
    return { error: String(err) };
  }
}
