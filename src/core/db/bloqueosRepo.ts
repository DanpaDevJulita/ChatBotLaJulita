import { supabase, supabaseConfigured } from "./supabase.js";

/**
 * Bloqueo temporal interno del bot (ver sql/bloqueos-temporales.sql) — cuando un cliente ya
 * eligió plan+fecha y quedó registrado (registrar_datos_reserva), se marca esa combinación
 * domo+capacidad+fecha como "tomada" por BLOQUEO_MINUTOS (10 por defecto) para que el bot no
 * se la vuelva a ofrecer a otro cliente mientras este paga. Si nadie confirma a tiempo, el
 * worker de bloqueoQueue la libera sola y avisa al cliente.
 *
 * OJO: esto NO toca LobbyPMS — es un candado propio, solo evita que el BOT prometa el mismo
 * cupo dos veces. Un vendedor reservando directo en LobbyPMS no lo ve (ver la nota en el SQL).
 */

export type ClaseDomoBloqueo = "chalet" | "clasico" | "deluxe";
export type EstadoBloqueo = "pendiente" | "confirmado" | "liberado";

export interface Bloqueo {
  id: number;
  canal: string;
  external_id: string;
  plan_id: number | null;
  clase_domo: ClaseDomoBloqueo;
  capacidad: number;
  fecha_entrada: string;
  noches: number;
  estado: EstadoBloqueo;
  creado_en: string;
  expira_en: string;
  avisado: boolean;
  /**
   * [2026-09-10] Ver sql/bloqueo-lobby-real.sql y src/core/integrations/lobbypms.ts — lo que
   * hace falta para que este candado interno también sea un bloqueo/reserva REAL en LobbyPMS.
   */
  cliente_id: number | null;
  personas: number | null;
  valor_total: number | null;
  lobby_block_id: number | null;
  lobby_category_id: number | null;
  lobby_booking_id: number | null;
  lobby_room_id: number | null;
  /**
   * [2026-09-10] Cuántos de `personas` son niños (menores de 18) — solo se sabe cuando el plan
   * es familiar o de amigos, que son los únicos donde `registrar_datos_reserva` pide la edad de
   * cada acompañante (ver reserva.ts). En cualquier otro plan queda en 0 (se asume que todos son
   * adultos, como siempre). Sirve para mandar `total_adults`/`total_children` correctos a
   * LobbyPMS al crear la reserva real (ver reservaLobby.ts).
   */
  ninos: number | null;
}

export interface NuevoBloqueo {
  canal: string;
  externalId: string;
  planId: number | null;
  claseDomo: ClaseDomoBloqueo;
  capacidad: number;
  fechaEntrada: string;
  noches?: number;
  minutosVigencia: number;
  clienteId?: number | null;
  personas?: number | null;
  valorTotal?: number | null;
  lobbyBlockId?: number | null;
  lobbyCategoryId?: number | null;
  ninos?: number | null;
}

/**
 * Crea el bloqueo y devuelve la fila (con su `expira_en` real, calculado por la base). `null`
 * si Supabase no está configurado o si la escritura falla — quien llama debe seguir igual sin
 * el bloqueo (mejor una reserva sin candado que un turno roto por esto).
 */
export async function crearBloqueo(datos: NuevoBloqueo): Promise<Bloqueo | null> {
  if (!supabaseConfigured) return null;
  const expira = new Date(Date.now() + datos.minutosVigencia * 60_000).toISOString();
  const { data, error } = await supabase
    .from("bloqueos_temporales")
    .insert({
      canal: datos.canal,
      external_id: datos.externalId,
      plan_id: datos.planId,
      clase_domo: datos.claseDomo,
      capacidad: datos.capacidad,
      fecha_entrada: datos.fechaEntrada,
      noches: datos.noches ?? 1,
      expira_en: expira,
      cliente_id: datos.clienteId ?? null,
      personas: datos.personas ?? null,
      valor_total: datos.valorTotal ?? null,
      lobby_block_id: datos.lobbyBlockId ?? null,
      lobby_category_id: datos.lobbyCategoryId ?? null,
      ninos: datos.ninos ?? null,
    })
    .select()
    .single();
  if (error) {
    console.error("[bloqueosRepo] crearBloqueo:", error.message);
    return null;
  }
  return data as Bloqueo;
}

/**
 * Cuántos bloqueos ACTIVOS (pendientes y todavía no vencidos) hay para esa clase+capacidad+
 * fecha, sin contar los de esta misma conversación (para que un cliente vea su propio bloqueo
 * como "su cupo", no como cupo perdido). Se usa para restarle a lo que devuelve LobbyPMS.
 *
 * [2026-09-11] Solo se cuentan los bloqueos SIN `lobby_block_id`, o sea los que LobbyPMS no
 * conoce. Desde que el bot también bloquea de verdad en LobbyPMS (POST /block, punto 1.2.c), un
 * bloqueo con `lobby_block_id` YA está descontado en el número que devuelve `available-rooms`:
 * restarlo otra vez acá contaba dos veces el mismo cupo y le escondía disponibilidad real a los
 * demás clientes. El candado interno sigue valiendo, y se sigue restando, cuando el bloqueo real
 * no se pudo crear (API caída, IP sin autorizar, categoría sin resolver).
 */
export async function contarBloqueosActivos(
  claseDomo: ClaseDomoBloqueo,
  capacidad: number,
  fechaEntrada: string,
  excluir?: { canal: string; externalId: string }
): Promise<number> {
  if (!supabaseConfigured) return 0;
  let query = supabase
    .from("bloqueos_temporales")
    .select("*", { count: "exact", head: true })
    .eq("clase_domo", claseDomo)
    .eq("capacidad", capacidad)
    .eq("fecha_entrada", fechaEntrada)
    .eq("estado", "pendiente")
    .gt("expira_en", new Date().toISOString())
    .is("lobby_block_id", null);
  if (excluir) {
    // NOT(canal = X AND external_id = Y)  ==  (canal != X) OR (external_id != Y) — así el
    // propio bloqueo de esta conversación no cuenta como "cupo ocupado por otro".
    query = query.or(`canal.neq.${excluir.canal},external_id.neq.${excluir.externalId}`);
  }
  const { count, error } = await query;
  if (error) {
    console.error("[bloqueosRepo] contarBloqueosActivos:", error.message);
    return 0;
  }
  return count ?? 0;
}

/** Todos los bloqueos pendientes de un canal — para que /confirmar busque por número (ver comandos.ts). */
export async function bloqueosPendientes(canal: string): Promise<Bloqueo[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from("bloqueos_temporales")
    .select("*")
    .eq("canal", canal)
    .eq("estado", "pendiente")
    .gt("expira_en", new Date().toISOString())
    .order("creado_en", { ascending: false });
  if (error) {
    console.error("[bloqueosRepo] bloqueosPendientes:", error.message);
    return [];
  }
  return (data as Bloqueo[]) ?? [];
}

export async function bloqueoPorId(id: number): Promise<Bloqueo | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase.from("bloqueos_temporales").select("*").eq("id", id).single();
  if (error) return null;
  return data as Bloqueo;
}

/** El equipo confirma el pago (ver comando /confirmar en comandos.ts): cancela la liberación. */
export async function confirmarBloqueo(id: number): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const { error } = await supabase
    .from("bloqueos_temporales")
    .update({ estado: "confirmado" })
    .eq("id", id)
    .eq("estado", "pendiente"); // si ya se liberó o ya estaba confirmado, no lo pisamos
  if (error) {
    console.error("[bloqueosRepo] confirmarBloqueo:", error.message);
    return false;
  }
  return true;
}

/**
 * Libera un bloqueo vencido (lo llama el worker cuando pasan los minutos y sigue "pendiente").
 * Devuelve `true` solo si de verdad lo liberó ahora (para no mandar el aviso dos veces si el
 * job corre más de una vez).
 */
export async function liberarBloqueoSiVencido(id: number): Promise<Bloqueo | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from("bloqueos_temporales")
    .update({ estado: "liberado", avisado: true })
    .eq("id", id)
    .eq("estado", "pendiente")
    .select()
    .single();
  if (error) return null; // no había nada que liberar (ya estaba confirmado/liberado) — normal
  return data as Bloqueo;
}

/** El bloqueo pendiente más reciente de una conversación (para /confirmar por número, o debug). */
export async function bloqueoPendienteDe(canal: string, externalId: string): Promise<Bloqueo | null> {
  if (!supabaseConfigured) return null;
  const { data, error } = await supabase
    .from("bloqueos_temporales")
    .select("*")
    .eq("canal", canal)
    .eq("external_id", externalId)
    .eq("estado", "pendiente")
    .gt("expira_en", new Date().toISOString())
    .order("creado_en", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[bloqueosRepo] bloqueoPendienteDe:", error.message);
    return null;
  }
  return (data as Bloqueo) ?? null;
}

/**
 * [2026-09-10] Guarda el booking_id/room_id reales de LobbyPMS una vez creada la reserva desde
 * /confirmar (ver src/core/pipeline/reservaLobby.ts). Es solo trazabilidad — no cambia `estado`.
 */
export async function guardarReservaLobby(id: number, bookingId: number, roomId: number | null): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const { error } = await supabase
    .from("bloqueos_temporales")
    .update({ lobby_booking_id: bookingId, lobby_room_id: roomId })
    .eq("id", id);
  if (error) {
    console.error("[bloqueosRepo] guardarReservaLobby:", error.message);
    return false;
  }
  return true;
}
