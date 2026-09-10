import { supabase, supabaseConfigured } from "./supabase.js";
import { ultimosDigitos } from "../lib/telefono.js";

/**
 * Registro de los datos de una reserva: quien reserva va a `clientes`, sus acompañantes a
 * `acompanantes`, y en medio se crea la fila de `reservas` que los une (porque
 * `acompanantes.reserva_id` es obligatorio).
 *
 * Estado del flujo: la reserva se crea como PENDIENTE DE PAGO y **sin domo asignado** — cuál
 * domo le toca lo decide el equipo cuando confirma el cupo, no el bot, que todavía no consulta
 * disponibilidad. Eso replica la etapa "CLIENTE PENDIENTE DE PAGO" del CRM.
 */

export interface DatosPersona {
  nombre: string;
  tipo_documento: string;
  numero_documento: string;
  celular?: string | null;
  correo?: string | null;
}

export interface DatosReserva {
  cliente: DatosPersona;
  acompanantes?: DatosPersona[];
  plan_id: number;
  fecha: string;
  numero_huespedes: number;
  valor_total?: number | null;
}

export interface ResultadoRegistro {
  ok: boolean;
  reserva_id?: number;
  cliente_id?: number;
  acompanantes_registrados?: number;
  /**
   * "completo"                -> cliente + reserva + acompañantes, todo guardado.
   * "cliente_y_acompanantes"  -> la base no deja crear la reserva sin domo, pero sí acepta
   *                              acompañantes sin reserva: quedaron cliente y acompañantes, y
   *                              el equipo los vincula a la reserva cuando asigne el domo.
   * "solo_cliente"            -> solo se pudo guardar el cliente; los datos de los
   *                              acompañantes van en `acompanantes_sin_guardar` para que el
   *                              equipo los tenga a la vista en la conversación.
   */
  modo?: "completo" | "cliente_y_acompanantes" | "solo_cliente";
  acompanantes_sin_guardar?: DatosPersona[];
  /** Motivo pensado para los logs, NO para mostrárselo al cliente. */
  motivo?: string;
}

// --- Catálogos (tablas chicas que no cambian: se cachean) -----------------------------------

let cacheTipos: { filas: { id: number; nombre: string; seudonimo: string }[]; at: number } | null = null;
let cacheEstados: { filas: { id: number; descripcion: string }[]; at: number } | null = null;
const TTL_CATALOGO_MS = 5 * 60_000;

function sinTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Cómo dice la gente su tipo de documento vs. la sigla del catálogo. */
const ALIAS_DOCUMENTO: [RegExp, string][] = [
  [/pasaporte|passport/, "PA"],
  [/extranjer/, "CE"],
  [/tarjeta de identidad|^ti$/, "TI"],
  [/nit/, "NIT"],
  [/cedula|cc|ciudadania|documento/, "CC"],
];

async function getTiposDocumento(): Promise<{ id: number; nombre: string; seudonimo: string }[]> {
  if (!supabaseConfigured) return [];
  if (cacheTipos && Date.now() - cacheTipos.at < TTL_CATALOGO_MS) return cacheTipos.filas;
  const { data, error } = await supabase.from("tipo_documento").select("*");
  if (error) {
    console.error("[reservasRepo] tipo_documento:", error.message);
    return [];
  }
  const filas = (data ?? []) as { id: number; nombre: string; seudonimo: string }[];
  cacheTipos = { filas, at: Date.now() };
  return filas;
}

/**
 * [2026-09-10] La inversa de `resolverTipoDocumento`: a partir del id que quedó guardado en
 * `clientes.tipo_documento_id`, el texto (seudónimo o nombre) que necesita, por ejemplo,
 * mapear el tipo de documento hacia LobbyPMS al crear la reserva real (ver
 * src/core/pipeline/reservaLobby.ts).
 */
export async function obtenerTextoTipoDocumento(id: number): Promise<string | null> {
  const tipos = await getTiposDocumento();
  const fila = tipos.find((t) => t.id === id);
  return fila?.seudonimo || fila?.nombre || null;
}

export async function resolverTipoDocumento(texto: string): Promise<number | null> {
  const tipos = await getTiposDocumento();
  if (tipos.length === 0) return null;
  const t = sinTildes(texto);

  const exacto = tipos.find((x) => sinTildes(x.seudonimo) === t || sinTildes(x.nombre) === t);
  if (exacto) return exacto.id;

  for (const [patron, sigla] of ALIAS_DOCUMENTO) {
    if (patron.test(t)) {
      const porSigla = tipos.find((x) => sinTildes(x.seudonimo) === sinTildes(sigla));
      if (porSigla) return porSigla.id;
    }
  }

  const parcial = tipos.find((x) => sinTildes(x.nombre).includes(t) || t.includes(sinTildes(x.seudonimo)));
  return parcial?.id ?? null;
}

async function getEstadoPendiente(): Promise<number | null> {
  if (!supabaseConfigured) return null;
  if (!cacheEstados || Date.now() - cacheEstados.at >= TTL_CATALOGO_MS) {
    const { data, error } = await supabase.from("estado").select("*");
    if (error) {
      console.error("[reservasRepo] estado:", error.message);
      return null;
    }
    cacheEstados = { filas: (data ?? []) as { id: number; descripcion: string }[], at: Date.now() };
  }
  const pendiente = cacheEstados.filas.find((e) => sinTildes(e.descripcion).includes("pendiente"));
  return pendiente?.id ?? cacheEstados.filas[0]?.id ?? null;
}

// --- Registro --------------------------------------------------------------------------------

/**
 * Inserta los acompañantes. `reservaId` en null es para el caso en que la base permite
 * acompañantes sin reserva todavía asignada (columna nullable): el equipo los vincula después.
 * Devuelve cuántos entraron y si la base rechazó la falta de reserva.
 */
/**
 * Inserta los acompañantes.
 *
 * [2026-09-08] La tabla quedó SIN la columna `reserva_id` (el equipo la borró: el bot no crea
 * reservas, así que colgar el acompañante de una reserva inexistente no servía). Por eso acá
 * solo se manda lo que la tabla tiene hoy: nombre, tipo y número de documento, y celular y
 * correo si el cliente los dio.
 *
 * `reservaId` se sigue recibiendo por si algún día se reactiva ese vínculo (con
 * CREAR_RESERVA_DESDE_BOT=true y la columna de vuelta): se agrega solo si viene con valor, así
 * que hoy simplemente no se usa. `clienteId` va solo a los logs, para poder rastrear a quién
 * acompañaba cada quien si algo sale mal.
 */
async function insertarAcompanantes(
  acompanantes: DatosPersona[],
  reservaId: number | null,
  clienteId: number
): Promise<{ registrados: number; exigeReserva: boolean }> {
  let registrados = 0;
  let exigeReserva = false;

  for (const acompanante of acompanantes) {
    const tipo = await resolverTipoDocumento(acompanante.tipo_documento);
    if (tipo == null) {
      console.error(
        `[reservasRepo] Acompañante "${acompanante.nombre}" (del cliente #${clienteId}) sin tipo de ` +
          `documento reconocible ("${acompanante.tipo_documento}"), no lo guardé.`
      );
      continue;
    }

    const fila: Record<string, unknown> = {
      nombre: acompanante.nombre,
      tipo_documento_id: tipo,
      numero_documento: acompanante.numero_documento,
      celular: acompanante.celular ?? null,
      correo: acompanante.correo ?? null,
    };
    if (reservaId != null) fila.reserva_id = reservaId;

    const { error } = await supabase.from("acompanantes").insert(fila);
    if (error) {
      if (error.code === "23502" || /reserva_id/i.test(error.message ?? "")) exigeReserva = true;
      console.error(
        `[reservasRepo] Acompañante "${acompanante.nombre}" (del cliente #${clienteId}):`,
        error.message
      );
    } else {
      registrados++;
    }
  }

  return { registrados, exigeReserva };
}

/**
 * Guarda cliente + reserva + acompañantes. Devuelve ok:false con un motivo para los logs si
 * falta algo — quien llama NUNCA debe mostrarle ese motivo al cliente.
 */
export async function registrarDatosReserva(datos: DatosReserva): Promise<ResultadoRegistro> {
  if (!supabaseConfigured) return { ok: false, motivo: "Supabase no está configurado" };

  const tipoCliente = await resolverTipoDocumento(datos.cliente.tipo_documento);
  if (tipoCliente == null) {
    return {
      ok: false,
      motivo:
        `no pude resolver el tipo de documento "${datos.cliente.tipo_documento}" — ` +
        "la tabla `tipo_documento` está vacía o no tiene ese tipo (ver sql/reserva-datos-cliente.sql)",
    };
  }

  // 1. Cliente. El unique(tipo_documento_id, numero_documento) del schema hace que un cliente
  //    que ya reservó antes se actualice en vez de duplicarse: una fila por PERSONA.
  const { data: cliente, error: errorCliente } = await supabase
    .from("clientes")
    .upsert(
      {
        nombre: datos.cliente.nombre,
        tipo_documento_id: tipoCliente,
        numero_documento: datos.cliente.numero_documento,
        celular: datos.cliente.celular ?? "",
        correo: datos.cliente.correo ?? null,
      },
      { onConflict: "tipo_documento_id,numero_documento" }
    )
    .select()
    .single();

  if (errorCliente || !cliente) {
    return { ok: false, motivo: `no pude guardar el cliente: ${errorCliente?.message ?? "sin fila"}` };
  }

  // 2. Acompañantes.
  //
  // [2026-09-08] Por decisión del equipo, el bot NO crea la reserva: la reserva la arma el
  // equipo cuando confirma el cupo y asigna el domo (dato que el bot no tiene). Así que los
  // acompañantes se guardan sin reserva y el equipo los vincula después — para eso
  // `acompanantes.reserva_id` tiene que ser opcional (ver sql/reserva-datos-cliente.sql).
  //
  // Si algún día se quiere que el bot cree la reserva completa, se pone
  // CREAR_RESERVA_DESDE_BOT=true en el .env y este mismo código la crea y vincula todo.
  const crearReserva = process.env.CREAR_RESERVA_DESDE_BOT === "true";

  if (!crearReserva) {
    const { registrados, exigeReserva } = await insertarAcompanantes(datos.acompanantes ?? [], null, cliente.id);

    if (exigeReserva) {
      return {
        ok: true,
        modo: "solo_cliente",
        cliente_id: cliente.id,
        acompanantes_registrados: 0,
        acompanantes_sin_guardar: datos.acompanantes ?? [],
        motivo:
          "el cliente quedó guardado, pero la tabla `acompanantes` rechazó los acompañantes " +
          "(revisá el error de arriba: puede faltar una columna obligatoria o el tipo de documento).",
      };
    }

    return {
      ok: true,
      modo: "cliente_y_acompanantes",
      cliente_id: cliente.id,
      acompanantes_registrados: registrados,
    };
  }

  // --- Camino completo: el bot también crea la reserva (CREAR_RESERVA_DESDE_BOT=true) ---
  const estadoId = await getEstadoPendiente();
  if (estadoId == null) {
    return {
      ok: true,
      modo: "solo_cliente",
      cliente_id: cliente.id,
      acompanantes_registrados: 0,
      acompanantes_sin_guardar: datos.acompanantes ?? [],
      motivo: "la tabla `estado` está vacía, así que no se pudo crear la reserva (el cliente sí quedó).",
    };
  }

  const { data: reserva, error: errorReserva } = await supabase
    .from("reservas")
    .insert({
      cliente_id: cliente.id,
      plan_id: datos.plan_id,
      fecha_reservada: datos.fecha,
      numero_huespedes: datos.numero_huespedes,
      valor_total: datos.valor_total ?? null,
      total: datos.valor_total ?? null,
      estado_id: estadoId,
    })
    .select()
    .single();

  if (errorReserva || !reserva) {
    // La base exige `reservas.domo_id` y el bot no puede asignar un domo sin saber
    // disponibilidad: se degrada a guardar los acompañantes sin reserva.
    const sinReserva = await insertarAcompanantes(datos.acompanantes ?? [], null, cliente.id);
    return {
      ok: true,
      modo: sinReserva.registrados > 0 ? "cliente_y_acompanantes" : "solo_cliente",
      cliente_id: cliente.id,
      acompanantes_registrados: sinReserva.registrados,
      acompanantes_sin_guardar: sinReserva.registrados > 0 ? undefined : datos.acompanantes ?? [],
      motivo: `no se pudo crear la reserva: ${errorReserva?.message ?? "sin fila"}`,
    };
  }

  const { registrados } = await insertarAcompanantes(datos.acompanantes ?? [], reserva.id, cliente.id);

  return {
    ok: true,
    modo: "completo",
    reserva_id: reserva.id,
    cliente_id: cliente.id,
    acompanantes_registrados: registrados,
  };
}

// --- Postventa: reservas confirmadas por celular ---------------------------------------------

export interface ReservaConfirmada {
  id: number;
  fecha_reservada: string;
  numero_huespedes: number;
  valor_total: number | null;
  anticipo: number | null;
  saldo: number | null;
  total: number | null;
  plan_nombre: string | null;
  estado_descripcion: string | null;
  cliente_nombre: string | null;
}

/**
 * [2026-09-10] Postventa: la reserva "real" de un cliente NUNCA se saca de lo que el bot
 * recuerda de la conversación — siempre se consulta la tabla `reservas`. Es la única fuente de
 * verdad porque una reserva puede haberse hecho FUERA del bot (el vendedor la registra en
 * LobbyPMS y desde ahí, cuando exista esa sincronización, llega a esta misma tabla).
 *
 * Cruce en dos pasos porque el celular vive en `clientes`, no en `reservas`:
 *   1. `clientes` cuyo celular coincide en los últimos 10 dígitos con el que escribe por
 *      WhatsApp (evita fallar por "+57", espacios o guiones de más).
 *   2. `reservas` de esos clientes cuyo estado (tabla `estado`, texto libre) contiene
 *      "confirmad" — nunca inventamos qué cuenta como confirmada, leemos lo que diga esa fila.
 *
 * Devuelve SIEMPRE un arreglo (vacío si no hay match, o si Supabase falla) — quien llama debe
 * tratar "vacío" como "no tiene reserva confirmada todavía", nunca como un error que frene el
 * turno.
 */
export async function buscarReservasConfirmadasPorCelular(celular: string): Promise<ReservaConfirmada[]> {
  if (!supabaseConfigured) return [];
  const digitos = ultimosDigitos(celular, 10);
  if (!digitos) return [];

  const { data: clientes, error: errorClientes } = await supabase
    .from("clientes")
    .select("id")
    .ilike("celular", `%${digitos}%`);
  if (errorClientes) {
    console.error("[reservasRepo] buscarReservasConfirmadasPorCelular (clientes):", errorClientes.message);
    return [];
  }
  const clienteIds = (clientes ?? []).map((c: { id: number }) => c.id);
  if (clienteIds.length === 0) return [];

  // `estado!inner(descripcion)` para poder filtrar por el texto del estado embebido (patrón
  // PostgREST: sin el !inner, .ilike("estado.descripcion", ...) no filtra la fila principal).
  const { data, error } = await supabase
    .from("reservas")
    .select(
      "id, fecha_reservada, numero_huespedes, valor_total, anticipo, saldo, total, " +
        "planes(nombre), estado!inner(descripcion), clientes(nombre)"
    )
    .in("cliente_id", clienteIds)
    .ilike("estado.descripcion", "%confirmad%")
    .order("fecha_reservada", { ascending: true });

  if (error) {
    console.error("[reservasRepo] buscarReservasConfirmadasPorCelular (reservas):", error.message);
    return [];
  }

  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    fecha_reservada: r.fecha_reservada,
    numero_huespedes: r.numero_huespedes,
    valor_total: r.valor_total ?? null,
    anticipo: r.anticipo ?? null,
    saldo: r.saldo ?? null,
    total: r.total ?? null,
    plan_nombre: r.planes?.nombre ?? null,
    estado_descripcion: r.estado?.descripcion ?? null,
    cliente_nombre: r.clientes?.nombre ?? null,
  }));
}
