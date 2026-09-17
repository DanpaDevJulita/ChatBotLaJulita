import { supabase, supabaseConfigured } from "./supabase.js";
import { abrirTicketTecnico } from "./ticketsRepo.js";

/**
 * [2026-09-13] Throttle de avisos técnicos al equipo de DESARROLLO — ver sql/alertas-tecnicas.sql
 * y src/core/pipeline/notificarDesarrollo.ts para el porqué completo.
 *
 * Igual que conversacionActivaRepo.ts, esto vive en la base (no en memoria del proceso) por la
 * misma razón que Daniel pidió para la reserva activa: con 200+ conversaciones en paralelo y
 * potencialmente más de un proceso del bot corriendo, "¿ya avisé de esta falla en las últimas 2
 * horas?" tiene que ser una pregunta con una sola respuesta compartida — si cada proceso llevara
 * su propia cuenta en memoria, cada uno mandaría su propio correo cada 2 horas (multiplicado por
 * cuántos procesos haya), y además se perdería el conteo en cada reinicio.
 */

export interface AlertaTecnica {
  clave: string;
  ultima_vez: string;
  veces: number;
  detalle: string | null;
}

/**
 * true si ya pasó `ventanaMs` desde el último aviso de esta MISMA falla (o si nunca se avisó).
 * No registra nada — quien llama decide si de verdad manda el aviso y, si lo manda, tiene que
 * llamar después a `registrarAlerta` (separado a propósito: si el envío del correo falla, no
 * queremos haber marcado igual que "ya se avisó").
 */
export async function debeAlertar(clave: string, ventanaMs: number): Promise<boolean> {
  if (!supabaseConfigured) return true; // sin base: no hay forma de recordar, se deja pasar siempre.

  const { data, error } = await supabase
    .from("alertas_tecnicas")
    .select("ultima_vez")
    .eq("clave", clave)
    .maybeSingle();

  if (error) {
    console.error("[alertasTecnicasRepo] debeAlertar:", error.message);
    return true; // ante la duda, mejor un correo de más que quedarse callado por un error de la propia base.
  }
  if (!data) return true;

  const edadMs = Date.now() - new Date(data.ultima_vez).getTime();
  return edadMs > ventanaMs;
}

/** Marca que se acaba de avisar de `clave` — llamar SOLO después de mandar (o intentar mandar) el aviso. */
export async function registrarAlerta(clave: string, detalle: string): Promise<void> {
  if (!supabaseConfigured) return;

  const actual = await supabase.from("alertas_tecnicas").select("veces").eq("clave", clave).maybeSingle();
  const vecesPrevias = actual.data?.veces ?? 0;

  const { error } = await supabase.from("alertas_tecnicas").upsert({
    clave,
    ultima_vez: new Date().toISOString(),
    veces: vecesPrevias + 1,
    detalle: detalle.slice(0, 2000),
    updated_at: new Date().toISOString(),
  });

  if (error) console.error("[alertasTecnicasRepo] registrarAlerta:", error.message);

  // Además del throttle del correo, dejamos un ticket en el panel para que la falla
  // quede con estado y responsable y no se pierda en la bandeja de nadie.
  await abrirTicketTecnico(clave, detalle);
}
