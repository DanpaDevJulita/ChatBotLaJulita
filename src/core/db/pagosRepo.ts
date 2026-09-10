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
