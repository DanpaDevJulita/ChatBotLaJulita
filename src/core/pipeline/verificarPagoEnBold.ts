import {
  obtenerEstadoCuenta,
  pagosPendientesConLink,
  registrarPagoAprobado,
} from "../db/pagosRepo.js";
import { consultarEstadoLink, boldConfigured } from "../integrations/boldClient.js";

/**
 * [2026-09-11] Le pregunta a Bold si el pago de una reserva ya entró, y si entró lo registra.
 *
 * Está acá, fuera de la herramienta del agente, porque lo usan DOS caminos distintos y tienen
 * que comportarse exactamente igual:
 *
 *   1. `verificar_pago` — cuando el cliente dice "ya pagué" (ver agentes/ventas/herramientas/pago.ts).
 *   2. La liberación del cupo — ANTES de soltar un cupo por vencimiento (ver bloqueo.ts). Ese es
 *      el caso que más duele: el cliente pagó, el webhook no llegó, él no escribió nada, y el bot
 *      le iba a decir "liberé tu cupo" cuando en realidad ya había pagado. Peor todavía, el cupo
 *      volvía a quedar disponible para otro cliente.
 *
 * Registra por la MISMA función de base que el webhook (fn_registrar_pago_aprobado), que es
 * idempotente: no importa cuál de los tres caminos llegue primero, el resultado es el mismo y no
 * se duplica nada.
 *
 * NUNCA da por pagado lo que no pudo verificar: si Bold no responde, `noSePudoConsultar` queda en
 * true y `pagado` en false. Quien llama decide, pero jamás debe interpretar un fallo de red como
 * un pago recibido.
 */
export interface ResultadoVerificacion {
  /** Bold confirmó el pago (o la reserva ya figuraba pagada). */
  pagado: boolean;
  /** El pago ya estaba registrado antes de esta consulta (lo registró el webhook u otra consulta). */
  yaEstabaRegistrado: boolean;
  /** La reserva ya no tenía saldo pendiente: no había nada que consultar. */
  yaSinSaldo: boolean;
  montoPagado?: number;
  saldoPendiente?: number;
  estadoPago?: string;
  /** Alguno de los links no se pudo consultar (Bold caído, llave mala). */
  noSePudoConsultar: boolean;
  /** No hay links pendientes que consultar (nunca se le generó uno). */
  sinLinksPendientes: boolean;
  /** Qué dijo Bold de cada link, para los logs. */
  estados: { referencia: string | null; estado: string | null }[];
}

const VACIO: ResultadoVerificacion = {
  pagado: false,
  yaEstabaRegistrado: false,
  yaSinSaldo: false,
  noSePudoConsultar: false,
  sinLinksPendientes: false,
  estados: [],
};

export async function verificarPagoEnBold(reservaId: number): Promise<ResultadoVerificacion> {
  if (!boldConfigured) {
    console.error("[verificarPagoEnBold] Falta BOLD_API_KEY: no puedo consultarle a Bold.");
    return { ...VACIO, noSePudoConsultar: true };
  }

  const pendientes = await pagosPendientesConLink(reservaId);

  if (pendientes.length === 0) {
    // O ya está todo pagado, o pagó un abono y no quedan links por consultar, o nunca se le
    // generó uno.
    const cuenta = await obtenerEstadoCuenta(reservaId);

    // [2026-09-14] BUG REAL (Daniel, prueba del 13/09): un cliente pagó su ABONO del 50%, el bot
    // se lo confirmó... y a los 10 minutos le liberó el cupo igual.
    //
    // Por qué: al pagarse, el link del abono deja de estar "pendiente", así que acá
    // `pendientes.length === 0`. Y como todavía queda saldo (pagó la mitad), la condición de
    // abajo (`saldo <= 0`) tampoco se cumplía — se caía en `sinLinksPendientes` con
    // `pagado: false`. La liberación de los 10 minutos (bloqueo.ts) consulta JUSTO esta función
    // antes de soltar el cupo: al leer `pagado: false` concluía que no había pagado nadie y
    // soltaba el cupo, incluso el block en LobbyPMS. O sea, el peor caso posible: el cliente
    // paga, se le confirma, y se le quita la reserva igual.
    //
    // La regla correcta es simple: si la reserva YA TIENE plata registrada, está pagada (total o
    // parcialmente) y su cupo es suyo. `yaSinSaldo` sigue significando lo de siempre (no queda
    // saldo) para que los mensajes al cliente no cambien.
    if (cuenta && cuenta.pagado > 0) {
      return {
        ...VACIO,
        pagado: true,
        yaEstabaRegistrado: true,
        yaSinSaldo: cuenta.saldo <= 0,
        montoPagado: cuenta.pagado,
        saldoPendiente: cuenta.saldo,
        estadoPago: cuenta.estado_pago,
      };
    }
    return { ...VACIO, sinLinksPendientes: true };
  }

  const estados: ResultadoVerificacion["estados"] = [];

  for (const pago of pendientes) {
    const estado = await consultarEstadoLink(pago.payment_link!);
    estados.push({ referencia: pago.referencia, estado: estado?.status ?? null });

    if (estado?.status !== "PAID") continue;

    const registrado = await registrarPagoAprobado({
      referencia: pago.referencia ?? "",
      boldPaymentId: estado.transactionId ?? `consulta-${pago.payment_link}`,
      valor: estado.total ?? pago.valor,
    });

    if (!registrado.ok) {
      console.error(
        `[verificarPagoEnBold] reserva #${reservaId}: Bold dice PAID pero no pude registrarlo:`,
        registrado.motivo
      );
      return { ...VACIO, noSePudoConsultar: true, estados };
    }

    console.log(
      `[verificarPagoEnBold] reserva #${reservaId}: Bold confirmó el pago (${pago.referencia}), ` +
        `${registrado.yaProcesado ? "ya estaba registrado" : "lo registré ahora"} — saldo ${registrado.saldoPendiente}.`
    );

    return {
      ...VACIO,
      pagado: true,
      yaEstabaRegistrado: registrado.yaProcesado,
      montoPagado: registrado.totalPagado ?? estado.total ?? pago.valor,
      saldoPendiente: registrado.saldoPendiente ?? 0,
      estadoPago: registrado.estadoPago,
      estados,
    };
  }

  const noSePudoConsultar = estados.some((e) => e.estado === null);
  console.log(`[verificarPagoEnBold] reserva #${reservaId}: todavía sin pago. Estados: ${JSON.stringify(estados)}`);
  return { ...VACIO, noSePudoConsultar, estados };
}
