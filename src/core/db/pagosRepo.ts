import { supabase, supabaseConfigured } from "./supabase.js";
import { ultimosDigitos } from "../lib/telefono.js";

/**
 * Acceso a la tabla `pagos` y al estado de cuenta de una reserva.
 *
 * REGLA DE ORO DE ESTE ARCHIVO: los montos NUNCA se calculan acá ni en la herramienta ni en el
 * modelo. Salen de las funciones de la base (fn_total_reserva, fn_saldo_reserva, expuestas en
 * la vista `v_estado_cuenta`), que son la unica fuente de verdad. Ver sql/pagos.sql.
 *
 * [2026-09-10] Version 1 del modulo de pagos: llega hasta GENERAR EL LINK. La confirmacion del
 * pago (webhook de Bold -> fn_registrar_pago_aprobado) queda pendiente para una version
 * siguiente; por eso acá no hay nada que apruebe un pago. Mientras tanto, quien confirma que
 * el dinero entro es el equipo, mirando Bold.
 */

/** Una fila de la vista `v_estado_cuenta`. */
export interface EstadoCuenta {
  reserva_id: number;
  cliente_id: number | null;
  cliente: string | null;
  documento: string | null;
  celular: string | null;
  fecha_checkin: string | null;
  fecha_fin_reserva: string | null;
  total: number;
  pagado: number;
  saldo: number;
  estado_pago: string;
  estado_reserva: string | null;
  num_pagos: number;
}

export type TipoPago = "total" | "abono" | "saldo";

export interface PagoPendiente {
  id: number;
  reserva_id: number;
  tipo: TipoPago;
  valor: number;
  referencia: string | null;
  payment_link: string | null;
  link_url: string | null;
}

/** Estado de cuenta de una reserva. `null` si no existe o si Supabase no esta configurado. */
export async function obtenerEstadoCuenta(reservaId: number): Promise<EstadoCuenta | null> {
  if (!supabaseConfigured) return null;

  const { data, error } = await supabase
    .from("v_estado_cuenta")
    .select("*")
    .eq("reserva_id", reservaId)
    .maybeSingle();

  if (error) {
    console.error("[pagosRepo] obtenerEstadoCuenta:", error.message);
    return null;
  }
  if (!data) return null;

  return {
    ...data,
    total: Number(data.total ?? 0),
    pagado: Number(data.pagado ?? 0),
    saldo: Number(data.saldo ?? 0),
    num_pagos: Number(data.num_pagos ?? 0),
  } as EstadoCuenta;
}

/**
 * Ultima reserva de quien escribe, buscada por celular. Es el plan B para cuando el modelo no
 * trae el `reserva_id` que devolvio `registrar_datos_reserva` en el mismo turno.
 *
 * El celular se compara por los ultimos 10 digitos porque en la base puede estar guardado como
 * "3001112233", "+573001112233" o "57 300 111 2233" segun quien lo haya escrito.
 */
/**
 * [2026-09-11] El camino INVERSO a ultimaReservaDeCelular: de una reserva, a la conversación de
 * WhatsApp por la que se la vendimos.
 *
 * Para qué: cuando Bold avisa que el pago entró (webhook), queremos escribirle al cliente solo,
 * sin que tenga que mandar el comprobante. Para eso hay que saber a qué chat escribirle, y el
 * webhook solo trae la referencia del pago.
 *
 * Cómo: la reserva sabe su `cliente_id`, el cliente tiene su `celular`, y en WhatsApp el
 * `external_id` de la conversación ES ese número (con "+57" adelante). Se cruzan por los últimos
 * dígitos, igual que ultimaReservaDeCelular, para no fallar por el indicativo o un espacio.
 *
 * Devuelve null si no se puede resolver — en ese caso el pago igual queda registrado en la base,
 * solo que el aviso al cliente lo tendrá que dar el equipo.
 */
export async function conversacionDeReserva(
  reservaId: number
): Promise<{ canal: string; externalId: string } | null> {
  if (!supabaseConfigured) return null;

  const { data: reserva, error: errRes } = await supabase
    .from("reservas")
    .select("cliente_id")
    .eq("id", reservaId)
    .maybeSingle();

  if (errRes || !reserva?.cliente_id) {
    if (errRes) console.error("[pagosRepo] conversacionDeReserva (reserva):", errRes.message);
    return null;
  }

  const { data: cliente, error: errCli } = await supabase
    .from("clientes")
    .select("celular")
    .eq("id", reserva.cliente_id)
    .maybeSingle();

  if (errCli || !cliente?.celular) {
    if (errCli) console.error("[pagosRepo] conversacionDeReserva (cliente):", errCli.message);
    return null;
  }

  const cola = ultimosDigitos(cliente.celular);
  if (cola.length < 7) return null;

  const { data, error } = await supabase
    .from("estado_conversacion")
    .select("canal, external_id")
    .ilike("external_id", `%${cola}%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[pagosRepo] conversacionDeReserva (estado_conversacion):", error.message);
    return null;
  }
  if (!data?.external_id) return null;

  return { canal: data.canal ?? "whatsapp", externalId: data.external_id };
}

export async function ultimaReservaDeCelular(celular: string): Promise<number | null> {
  if (!supabaseConfigured) return null;

  const cola = ultimosDigitos(celular);
  if (cola.length < 7) return null;

  const { data: clientes, error: errCli } = await supabase
    .from("clientes")
    .select("id, celular")
    .ilike("celular", `%${cola}%`);

  if (errCli) {
    console.error("[pagosRepo] ultimaReservaDeCelular (clientes):", errCli.message);
    return null;
  }
  const ids = (clientes ?? []).map((c) => c.id);
  if (ids.length === 0) return null;

  const { data, error } = await supabase
    .from("reservas")
    .select("id")
    .in("cliente_id", ids)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[pagosRepo] ultimaReservaDeCelular (reservas):", error.message);
    return null;
  }
  return data?.id ?? null;
}

/**
 * Link ya generado y todavia sin pagar para esa reserva y ese tipo.
 *
 * Se consulta ANTES de crear uno nuevo: si el cliente vuelve a pedir los datos de pago, se le
 * reenvia el mismo link en vez de generar otro. La base tambien lo impide por su cuenta (indice
 * unico parcial sobre (reserva_id, tipo) donde estado = 'pendiente'), pero es mejor reusarlo a
 * proposito que chocar contra el error.
 */
/**
 * [2026-09-11] Datos de la reserva para armar el mensaje del pago: desde que el link se manda en
 * el MISMO turno en que se registra la reserva, el mensaje de `enviar_datos_pago` es el único que
 * ve el cliente, así que tiene que poder decirle qué plan, qué fecha y con quién quedó anotado.
 */
export interface ResumenReserva {
  plan: string | null;
  fecha: string | null;
  huespedes: number | null;
  acompanantes: string[];
}

export async function resumenDeReserva(reservaId: number): Promise<ResumenReserva | null> {
  if (!supabaseConfigured) return null;

  const { data, error } = await supabase
    .from("reservas")
    .select("fecha_reservada, numero_huespedes, planes(nombre)")
    .eq("id", reservaId)
    .maybeSingle();

  if (error) {
    console.error("[pagosRepo] resumenDeReserva:", error.message);
    return null;
  }
  if (!data) return null;

  const plan = (data as any)?.planes?.nombre ?? null;

  // Los acompañantes son un "lindo de tener": si la consulta falla, el mensaje sale igual sin
  // los nombres en vez de romperse.
  let acompanantes: string[] = [];
  const { data: filas, error: errAcom } = await supabase
    .from("acompanantes")
    .select("nombre")
    .eq("reserva_id", reservaId);
  if (errAcom) console.error("[pagosRepo] resumenDeReserva (acompanantes):", errAcom.message);
  else acompanantes = (filas ?? []).map((f: any) => String(f.nombre ?? "").trim()).filter(Boolean);

  return {
    plan,
    fecha: (data as any)?.fecha_reservada ?? null,
    huespedes: (data as any)?.numero_huespedes ?? null,
    acompanantes,
  };
}

/**
 * [2026-09-11] TODOS los pagos pendientes de una reserva que ya tienen link generado.
 *
 * Lo usa `verificar_pago`: cuando el cliente dice "ya pagué", hay que preguntarle a Bold por
 * cada link que le mandamos (puede haber uno de abono y otro de total si cambió de idea), en vez
 * de pedirle el comprobante.
 */
export async function pagosPendientesConLink(reservaId: number): Promise<PagoPendiente[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from("pagos")
    .select("id, reserva_id, tipo, valor, referencia, payment_link, link_url")
    .eq("reserva_id", reservaId)
    .eq("estado", "pendiente")
    .order("id", { ascending: false });

  if (error) {
    console.error("[pagosRepo] pagosPendientesConLink:", error.message);
    return [];
  }
  return ((data ?? []) as PagoPendiente[]).filter((p) => Boolean(p.payment_link));
}

export async function pagoPendienteDe(reservaId: number, tipo: TipoPago): Promise<PagoPendiente | null> {
  if (!supabaseConfigured) return null;

  const { data, error } = await supabase
    .from("pagos")
    .select("id, reserva_id, tipo, valor, referencia, payment_link, link_url")
    .eq("reserva_id", reservaId)
    .eq("tipo", tipo)
    .eq("estado", "pendiente")
    .maybeSingle();

  if (error) {
    console.error("[pagosRepo] pagoPendienteDe:", error.message);
    return null;
  }
  if (!data) return null;
  return { ...data, valor: Number(data.valor) } as PagoPendiente;
}

export interface ResultadoCrearPago {
  ok: boolean;
  id_pago?: number;
  /** Mensaje tecnico para el log. NUNCA se le muestra al cliente. */
  motivo?: string;
}

/**
 * Crea la fila de `pagos` en estado 'pendiente' llamando a fn_crear_pago_pendiente.
 *
 * La validacion del monto (no mayor al saldo, no cero, no negativo) la hace la funcion en la
 * base, no este codigo: asi vale igual si algun dia el pago se crea desde el panel del equipo
 * y no desde el bot.
 */
export async function crearPagoPendiente(params: {
  reservaId: number;
  valor: number;
  tipo: TipoPago;
  referencia: string;
  metodo?: string;
}): Promise<ResultadoCrearPago> {
  if (!supabaseConfigured) {
    return { ok: false, motivo: "Supabase no esta configurado" };
  }

  const { data, error } = await supabase.rpc("fn_crear_pago_pendiente", {
    p_reserva_id: params.reservaId,
    p_valor: params.valor,
    p_tipo: params.tipo,
    p_referencia: params.referencia,
    p_metodo: params.metodo ?? "bold",
  });

  if (error) {
    console.error("[pagosRepo] crearPagoPendiente:", error.message);
    return { ok: false, motivo: error.message };
  }
  return { ok: true, id_pago: Number(data) };
}

/** Guarda el link que devolvio Bold en la fila del pago ya creada. */
export async function guardarLinkDeBold(
  idPago: number,
  paymentLink: string,
  linkUrl: string
): Promise<boolean> {
  if (!supabaseConfigured) return false;

  const { error } = await supabase
    .from("pagos")
    .update({ payment_link: paymentLink, link_url: linkUrl, updated_at: new Date().toISOString() })
    .eq("id", idPago);

  if (error) {
    console.error("[pagosRepo] guardarLinkDeBold:", error.message);
    return false;
  }
  return true;
}

export interface ResultadoRegistrarPago {
  ok: boolean;
  yaProcesado: boolean;
  /** true si `referencia` no existe en `pagos` — no es un error de base, es un dato desconocido. */
  referenciaDesconocida?: boolean;
  idPago?: number;
  reservaId?: number;
  totalReserva?: number;
  totalPagado?: number;
  saldoPendiente?: number;
  estadoPago?: string;
  estadoReserva?: string;
  /** Mensaje tecnico para el log. NUNCA se le muestra al cliente. */
  motivo?: string;
}

/**
 * Llama a fn_registrar_pago_aprobado (sql/pagos.sql) — la unica funcion que marca un pago como
 * aprobado y actualiza la reserva (monto_pagado, saldo_pendiente, estado_pago, estado_reserva).
 * La usa el webhook de Bold (ver web/server.ts, POST /webhooks/bold).
 *
 * Es idempotente del lado de la base: si Bold reintenta el mismo bold_payment_id (lo hace hasta
 * 5 veces en 24h si no respondemos 200 a tiempo), la segunda llamada no vuelve a sumar el pago
 * (yaProcesado = true).
 *
 * Si `referencia` no existe en `pagos` (nunca se genero un link con ese reference), la funcion
 * de la base lanza una excepcion en vez de devolver una fila vacia — se distingue ese caso
 * (`referenciaDesconocida`) de un error real, para que el webhook responda 200 igual (reintentar
 * no va a hacer que esa referencia empiece a existir) en vez de un 500 que le haria a Bold
 * reintentar en vano.
 */
export async function registrarPagoAprobado(params: {
  referencia: string;
  boldPaymentId: string;
  valor?: number | null;
  numeroComprobante?: string | null;
  cus?: string | null;
}): Promise<ResultadoRegistrarPago> {
  if (!supabaseConfigured) {
    return { ok: false, yaProcesado: false, motivo: "Supabase no esta configurado" };
  }

  const { data, error } = await supabase.rpc("fn_registrar_pago_aprobado", {
    p_referencia: params.referencia,
    p_bold_payment_id: params.boldPaymentId,
    p_valor: params.valor ?? null,
    p_numero_comprobante: params.numeroComprobante ?? null,
    p_cus: params.cus ?? null,
  });

  if (error) {
    const referenciaDesconocida = /no existe un pago con referencia/i.test(error.message);
    if (!referenciaDesconocida) console.error("[pagosRepo] registrarPagoAprobado:", error.message);
    return { ok: false, yaProcesado: false, referenciaDesconocida, motivo: error.message };
  }

  const fila = Array.isArray(data) ? data[0] : data;
  if (!fila) {
    return { ok: false, yaProcesado: false, motivo: "fn_registrar_pago_aprobado no devolvio fila" };
  }

  return {
    ok: Boolean(fila.o_ok),
    yaProcesado: Boolean(fila.o_ya_procesado),
    idPago: fila.o_id_pago ?? undefined,
    reservaId: fila.o_reserva_id ?? undefined,
    totalReserva: fila.o_total_reserva != null ? Number(fila.o_total_reserva) : undefined,
    totalPagado: fila.o_total_pagado != null ? Number(fila.o_total_pagado) : undefined,
    saldoPendiente: fila.o_saldo_pendiente != null ? Number(fila.o_saldo_pendiente) : undefined,
    estadoPago: fila.o_estado_pago ?? undefined,
    estadoReserva: fila.o_estado_reserva ?? undefined,
  };
}

/**
 * Anula un pago pendiente. Se usa cuando la fila ya se creo pero Bold no devolvio el link: si
 * se dejara 'pendiente', el indice unico bloquearia el proximo intento y el cliente se quedaria
 * sin poder pagar hasta que alguien lo destrabe a mano.
 */
export async function anularPagoPendiente(idPago: number): Promise<void> {
  if (!supabaseConfigured) return;

  const { error } = await supabase
    .from("pagos")
    .update({ estado: "anulado", updated_at: new Date().toISOString() })
    .eq("id", idPago)
    .eq("estado", "pendiente");

  if (error) console.error("[pagosRepo] anularPagoPendiente:", error.message);
}
