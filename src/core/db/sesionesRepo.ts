import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * Sesiones del equipo: cuando alguien se identifica por WhatsApp con el código secreto + su
 * usuario y clave, su número queda habilitado unas horas para corregir al bot.
 *
 * Va en la base (no en memoria) por dos razones: sobrevive a un reinicio del worker, y sirve
 * igual si algún día corren más de un worker.
 */
export interface SesionEquipo {
  canal: string;
  external_id: string;
  usuario: string;
  expira_en: string;
}

export async function crearSesion(
  canal: string,
  externalId: string,
  usuario: string,
  horas: number
): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const expira = new Date(Date.now() + horas * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("sesiones_equipo")
    .upsert({ canal, external_id: externalId, usuario, expira_en: expira });
  if (error) {
    console.error("[sesionesRepo] crearSesion:", error.message);
    return false;
  }
  return true;
}

/** El usuario identificado en ese número, o null si no hay sesión o ya venció. */
export async function usuarioDeSesion(canal: string, externalId: string): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from("sesiones_equipo")
    .select("*")
    .eq("canal", canal)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) {
    console.error("[sesionesRepo] usuarioDeSesion:", error.message);
    return null;
  }
  const sesion = data as SesionEquipo | null;
  if (!sesion) return null;
  if (Date.parse(sesion.expira_en) <= Date.now()) return null;
  return sesion.usuario;
}

export async function cerrarSesion(canal: string, externalId: string): Promise<void> {
  if (!supabaseConfigured) return;
  const { error } = await supabase
    .from("sesiones_equipo")
    .delete()
    .eq("canal", canal)
    .eq("external_id", externalId);
  if (error) console.error("[sesionesRepo] cerrarSesion:", error.message);
}
