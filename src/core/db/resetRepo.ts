import { supabase, supabaseConfigured } from "./supabase.js";
import { ultimosDigitos } from "../lib/telefono.js";

/**
 * [2026-09-17] Dejar UN número "como cliente nuevo", para poder probar el bot una y otra vez
 * desde el mismo teléfono sin que arrastre la charla anterior (pedido de Daniel).
 *
 * Es la versión ejecutable de `sql/limpiar-pruebas-numero.sql`, que hasta ahora había que correr
 * a mano en Supabase pegando el número en siete lugares. Acá vive solo la parte de la BASE; las
 * cachés en memoria del proceso y el buffer de Redis los limpia quien llama (ver el comando
 * `/reset` en core/pipeline/comandos.ts), porque no viven en la base.
 *
 * POR QUÉ BORRA TAMBIÉN AL CLIENTE Y SUS RESERVAS
 * -----------------------------------------------
 * Porque si no, la prueba no arranca limpia: el bot busca al cliente por su celular
 * (`buscarClienteConocidoPorCelular` en reservasRepo.ts) y lo saluda por su nombre con los datos
 * que ya tenía cargados, y una reserva vieja del mismo número puede volver a aparecer. "Sin
 * memoria" de verdad quiere decir que no quede ninguna fila que lo mencione.
 *
 * CÓMO SE IDENTIFICA EL NÚMERO
 * ----------------------------
 * Por los ÚLTIMOS 10 DÍGITOS, igual que en todo el resto del bot (ver ultimosDigitos y clave()
 * en comandos.ts). Hace falta porque el mismo teléfono queda guardado con formatos distintos
 * según la tabla: en `clientes.celular` suele estar como "3212191805" y en
 * `mensajes.external_id` como "+573212191805".
 *
 * SIN TRANSACCIÓN
 * ---------------
 * supabase-js habla por REST, así que no hay un BEGIN/COMMIT como en el .sql: son borrados
 * sueltos, en orden seguro para las llaves foráneas (primero lo que cuelga de la reserva, después
 * la reserva, después el cliente). Si uno falla, los anteriores YA se borraron — por eso cada
 * paso reporta su error y el comando se lo muestra a quien lo pidió, en vez de decir "listo" sin
 * más. Para una herramienta de pruebas es un cambio aceptable; para datos de producción sigue
 * estando el .sql, que sí es transaccional.
 */

export interface ConteoConversacion {
  mensajes: number;
  estado: number;
  bloqueos: number;
  clientes: number;
  reservas: number;
  pagos: number;
  acompanantes: number;
  /** De los bloqueos/reservas de arriba, cuántos además existen en LobbyPMS (ver más abajo). */
  enLobbyPms: number;
}

const VACIO: ConteoConversacion = {
  mensajes: 0,
  estado: 0,
  bloqueos: 0,
  clientes: 0,
  reservas: 0,
  pagos: 0,
  acompanantes: 0,
  enLobbyPms: 0,
};

export function totalDe(conteo: ConteoConversacion): number {
  return (
    conteo.mensajes +
    conteo.estado +
    conteo.bloqueos +
    conteo.clientes +
    conteo.reservas +
    conteo.pagos +
    conteo.acompanantes
  );
}

/** Los ids de `clientes` que corresponden a este teléfono (puede haber más de uno). */
async function idsDeClientes(externalId: string): Promise<number[]> {
  const digitos = ultimosDigitos(externalId, 10);
  if (!digitos) return [];
  const { data, error } = await supabase.from("clientes").select("id").ilike("celular", `%${digitos}%`);
  if (error) {
    console.error("[resetRepo] buscando clientes:", error.message);
    return [];
  }
  return (data ?? []).map((c) => (c as { id: number }).id);
}

/** Los ids de `reservas` de esos clientes. */
async function idsDeReservas(clienteIds: number[]): Promise<number[]> {
  if (clienteIds.length === 0) return [];
  const { data, error } = await supabase.from("reservas").select("id").in("cliente_id", clienteIds);
  if (error) {
    console.error("[resetRepo] buscando reservas:", error.message);
    return [];
  }
  return (data ?? []).map((r) => (r as { id: number }).id);
}

/**
 * Los ids de `bloqueos_temporales` de este número, por DOS caminos que hay que juntar:
 *   - los de esta conversación (canal + external_id), que es lo obvio;
 *   - los que apuntan al cliente con `cliente_id`, aunque su external_id no coincida.
 *
 * El segundo camino no es un detalle: `bloqueos_temporales.cliente_id` tiene una llave foránea
 * contra `clientes`, así que mientras quede UN bloqueo apuntando al cliente, borrar el cliente
 * falla con "violates foreign key constraint bloqueos_temporales_cliente_id_fkey". Apareció en
 * el primer /reset de verdad (2026-09-17): la prueba no lo había encontrado porque los datos
 * sembrados no tenían ningún bloqueo de cupo.
 *
 * Se devuelven como un conjunto de ids para que contar y borrar miren exactamente lo mismo.
 */
async function idsDeBloqueos(canal: string, digitos: string, clienteIds: number[]): Promise<number[]> {
  const ids = new Set<number>();

  const { data: porConversacion, error: e1 } = await supabase
    .from("bloqueos_temporales")
    .select("id")
    .eq("canal", canal)
    .ilike("external_id", `%${digitos}%`);
  if (e1) console.error("[resetRepo] buscando bloqueos por conversación:", e1.message);
  for (const b of porConversacion ?? []) ids.add((b as { id: number }).id);

  if (clienteIds.length > 0) {
    const { data: porCliente, error: e2 } = await supabase
      .from("bloqueos_temporales")
      .select("id")
      .in("cliente_id", clienteIds);
    if (e2) console.error("[resetRepo] buscando bloqueos por cliente:", e2.message);
    for (const b of porCliente ?? []) ids.add((b as { id: number }).id);
  }

  return [...ids];
}

/**
 * Qué columna pedirle a cada tabla para contar y para saber cuántas filas se borraron.
 *
 * `estado_conversacion` NO tiene `id`: su clave primaria es (canal, external_id) — ver
 * sql/schema.sql. Pedirle "id" hace fallar la consulta entera y en silencio, así que la fila del
 * estado sobrevivía al reset y el bot seguía recordando el último agente, el escalamiento y la
 * reserva activa. Se detectó al probar este repo contra la base de verdad.
 */
const COLUMNA_CLAVE: Record<string, string> = {
  estado_conversacion: "external_id",
};

function claveDe(tabla: string): string {
  return COLUMNA_CLAVE[tabla] ?? "id";
}

async function contarFilas(tabla: string, aplicar: (q: any) => any): Promise<number> {
  const { count, error } = await aplicar(
    supabase.from(tabla).select(claveDe(tabla), { count: "exact", head: true })
  );
  if (error) {
    console.error(`[resetRepo] contando ${tabla}:`, error.message || JSON.stringify(error));
    return 0;
  }
  return count ?? 0;
}

/**
 * Qué hay hoy guardado de este número, SIN borrar nada. Es el "PASO 1 — MIRAR" del .sql: lo que
 * se le muestra a quien escribe `/reset` antes de pedirle que confirme.
 */
export async function contarConversacion(canal: string, externalId: string): Promise<ConteoConversacion> {
  if (!supabaseConfigured) return { ...VACIO };

  const digitos = ultimosDigitos(externalId, 10);
  if (!digitos) return { ...VACIO };

  const clienteIds = await idsDeClientes(externalId);
  const reservaIds = await idsDeReservas(clienteIds);
  const bloqueoIds = await idsDeBloqueos(canal, digitos, clienteIds);

  const porConversacion = (q: any) => q.eq("canal", canal).ilike("external_id", `%${digitos}%`);

  // Bloqueos que además dejaron un bloqueo o una reserva REAL en LobbyPMS: borrar la fila de acá
  // no los quita de allá, así que se cuentan aparte para poder avisarlo.
  const enLobby = bloqueoIds.length
    ? await contarFilas("bloqueos_temporales", (q: any) =>
        q.in("id", bloqueoIds).or("lobby_block_id.not.is.null,lobby_booking_id.not.is.null")
      )
    : 0;

  return {
    mensajes: await contarFilas("mensajes", porConversacion),
    estado: await contarFilas("estado_conversacion", porConversacion),
    bloqueos: bloqueoIds.length,
    clientes: clienteIds.length,
    reservas: reservaIds.length,
    pagos: reservaIds.length ? await contarFilas("pagos", (q: any) => q.in("reserva_id", reservaIds)) : 0,
    acompanantes: reservaIds.length
      ? await contarFilas("acompanantes", (q: any) => q.in("reserva_id", reservaIds))
      : 0,
    enLobbyPms: enLobby,
  };
}

export interface ResultadoBorrado {
  borrado: ConteoConversacion;
  /** Vacío si todo salió bien. Cada entrada es "tabla: motivo". */
  errores: string[];
}

async function borrarFilas(tabla: string, aplicar: (q: any) => any): Promise<{ filas: number; error?: string }> {
  const { data, error } = await aplicar(supabase.from(tabla).delete()).select(claveDe(tabla));
  if (error) {
    const motivo = error.message || JSON.stringify(error);
    console.error(`[resetRepo] borrando ${tabla}:`, motivo);
    return { filas: 0, error: `${tabla}: ${motivo}` };
  }
  return { filas: (data ?? []).length };
}

/**
 * Borra TODO lo que este número dejó guardado. Es el "PASO 2 — BORRAR" del .sql.
 *
 * El orden importa por las llaves foráneas: pagos y acompañantes cuelgan de la reserva, la
 * reserva cuelga del cliente. Al final va la conversación en sí, que no depende de nada.
 */
export async function borrarConversacion(canal: string, externalId: string): Promise<ResultadoBorrado> {
  const borrado: ConteoConversacion = { ...VACIO };
  const errores: string[] = [];

  if (!supabaseConfigured) {
    errores.push("supabase: no está configurado (faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    return { borrado, errores };
  }

  const digitos = ultimosDigitos(externalId, 10);
  if (!digitos) {
    errores.push("numero: no pude sacarle 10 dígitos al número");
    return { borrado, errores };
  }

  const clienteIds = await idsDeClientes(externalId);
  const reservaIds = await idsDeReservas(clienteIds);
  const bloqueoIds = await idsDeBloqueos(canal, digitos, clienteIds);

  const anotar = (campo: keyof ConteoConversacion, r: { filas: number; error?: string }) => {
    borrado[campo] += r.filas;
    if (r.error) errores.push(r.error);
  };

  // EL ORDEN ES LO ÚNICO DELICADO DE ESTA FUNCIÓN. Hay tres tablas que apuntan a `clientes` con
  // una llave foránea — `reservas.cliente_id`, `pagos.cliente_id` y `bloqueos_temporales.
  // cliente_id` — y mientras quede una sola fila apuntando, borrar el cliente falla. Así que
  // primero se vacía todo lo que cuelga, de la hoja hacia la raíz, y el cliente va de último.
  //
  // (Se aprendió a los golpes: la primera versión borraba los bloqueos al final, después del
  // cliente, y el primer /reset real reventó con bloqueos_temporales_cliente_id_fkey.)
  if (reservaIds.length > 0) {
    anotar("pagos", await borrarFilas("pagos", (q: any) => q.in("reserva_id", reservaIds)));
    anotar("acompanantes", await borrarFilas("acompanantes", (q: any) => q.in("reserva_id", reservaIds)));
    anotar("reservas", await borrarFilas("reservas", (q: any) => q.in("id", reservaIds)));
  }
  if (bloqueoIds.length > 0) {
    anotar("bloqueos", await borrarFilas("bloqueos_temporales", (q: any) => q.in("id", bloqueoIds)));
  }
  if (clienteIds.length > 0) {
    // Barrido final por si quedó algún pago colgado del cliente sin pasar por una reserva suya.
    anotar("pagos", await borrarFilas("pagos", (q: any) => q.in("cliente_id", clienteIds)));
    anotar("clientes", await borrarFilas("clientes", (q: any) => q.in("id", clienteIds)));
  }

  // La conversación en sí no depende de nada, así que puede ir al final sin riesgo.
  const porConversacion = (q: any) => q.eq("canal", canal).ilike("external_id", `%${digitos}%`);
  anotar("mensajes", await borrarFilas("mensajes", porConversacion));
  anotar("estado", await borrarFilas("estado_conversacion", porConversacion));

  return { borrado, errores };
}
