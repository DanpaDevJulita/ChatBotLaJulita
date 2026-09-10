import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import {
  obtenerEstadoCuenta,
  ultimaReservaDeCelular,
  pagoPendienteDe,
  crearPagoPendiente,
  guardarLinkDeBold,
  anularPagoPendiente,
  type EstadoCuenta,
  type TipoPago,
} from "../../../core/db/pagosRepo.js";
import {
  crearLinkDePago,
  construirReference,
  boldConfigured,
  type LinkDePago,
} from "../../../core/integrations/boldClient.js";

/**
 * enviar_datos_pago — VERSION 1 del modulo de pagos.
 *
 * ALCANCE (decidido con el equipo el 2026-09-10): esta herramienta llega hasta ENTREGAR EL
 * LINK. No confirma pagos, no dice que una reserva quedo pagada y no consulta si el dinero
 * entro. Quien verifica el pago es el equipo, mirando Bold. La confirmacion automatica
 * (webhook de Bold -> fn_registrar_pago_aprobado, que ya existe y esta probada en
 * sql/pagos.sql) queda para una version siguiente.
 *
 * POR QUE DOS LINKS: Bold no tiene una modalidad intermedia. Un link es de monto CERRADO
 * (CLOSE, el huesped no lo puede cambiar) o de monto ABIERTO (OPEN, el huesped digita cuanto
 * paga). No existe "precargado pero editable". Como el equipo quiere ofrecer las dos cosas
 * -- pagar todo, o abonar -- se generan los dos y se mandan juntos.
 *
 * REGLA DE ORO: ninguna cifra de este archivo se calcula a ojo ni la pone el modelo. El total
 * y el saldo salen de la base (fn_total_reserva / fn_saldo_reserva, via v_estado_cuenta) y el
 * anticipo sugerido es el 50% de ese saldo. Por eso `permitirRedaccion` va en false: el texto
 * se manda EXACTO, sin que el modelo lo reescriba.
 */

/** Porcentaje que se sugiere abonar para apartar la fecha. Ya se lo promete registrar_datos_reserva. */
const PORCENTAJE_ANTICIPO = 0.5;

function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);
}

/** Bold solo acepta enteros. Se redondea a miles para no mandar un anticipo de $348.512. */
function anticipoSugerido(saldo: number): number {
  const bruto = saldo * PORCENTAJE_ANTICIPO;
  const enMiles = Math.round(bruto / 1000) * 1000;
  // Nunca menos de mil ni mas que el saldo (una reserva muy chica podria redondear feo).
  return Math.min(Math.max(enMiles, 1000), Math.floor(saldo));
}

/**
 * Consigue el link de un tipo: si ya hay uno pendiente lo reusa, y si no, crea la fila en
 * `pagos` y pide el link a Bold.
 *
 * El orden importa: PRIMERO la fila en la base (que valida el monto contra el saldo y bloquea
 * un segundo link del mismo tipo) y DESPUES el link en Bold. Si Bold falla, la fila se anula
 * para no dejar bloqueado el proximo intento.
 */
async function conseguirLink(
  reservaId: number,
  tipo: TipoPago,
  valorParaLaBase: number,
  montoDelLink: number,
  modalidad: "CLOSE" | "OPEN",
  descripcion: string
): Promise<{ url: string; reusado: boolean } | { error: string }> {
  const yaExiste = await pagoPendienteDe(reservaId, tipo);
  if (yaExiste?.link_url) {
    return { url: yaExiste.link_url, reusado: true };
  }

  // Habia una fila pendiente pero sin link (Bold fallo en un intento anterior): se anula para
  // poder crear una limpia, porque el indice unico no deja tener dos del mismo tipo.
  if (yaExiste && !yaExiste.link_url) {
    await anularPagoPendiente(yaExiste.id);
  }

  const referencia = construirReference(reservaId, tipo);
  const creado = await crearPagoPendiente({ reservaId, valor: valorParaLaBase, tipo, referencia });
  if (!creado.ok || creado.id_pago == null) {
    return { error: `no se pudo registrar el pago ${tipo}: ${creado.motivo}` };
  }

  let link: LinkDePago;
  try {
    link = await crearLinkDePago({ amountCop: montoDelLink, modalidad, reference: referencia, description: descripcion });
  } catch (err) {
    await anularPagoPendiente(creado.id_pago);
    return { error: `Bold no devolvio el link ${tipo}: ${err instanceof Error ? err.message : String(err)}` };
  }

  await guardarLinkDeBold(creado.id_pago, link.paymentLink, link.url);
  return { url: link.url, reusado: false };
}

/** Mensaje unico para cuando algo falla por dentro: el cliente nunca ve un error tecnico. */
const DERIVAR_AL_EQUIPO =
  "Déjame confirmar un detalle del pago con el equipo de La Julita y en un momento te paso los datos 🙏";

export const enviarDatosPagoTool: ToolDefinition = {
  name: "enviar_datos_pago",
  // El texto va LITERAL: montos y links no se reformulan.
  permitirRedaccion: false,
  description:
    "Entrega los datos de pago de una reserva ya registrada: cuánto es el total, cuánto falta por pagar, cuánto es el anticipo sugerido para apartar la fecha, y los links de pago. Llamala cuando el cliente ya tiene la reserva registrada y dice que quiere pagar o pregunta cómo pagar. NO confirma pagos ni dice que una reserva quedó pagada: eso lo verifica el equipo.",
  parameters: {
    type: "object",
    properties: {
      reserva_id: {
        type: "integer",
        description:
          "El número de reserva que devolvió registrar_datos_reserva en esta misma conversación. Si no lo tienes, no lo inventes: deja el campo vacío y se busca por el celular de quien escribe.",
      },
    },
    required: [],
  },
  handler: async (args: { reserva_id?: number }, ctx: ToolContext) => {
    // --- 1. De qué reserva estamos hablando ---
    let reservaId = Number(args?.reserva_id) || null;
    if (!reservaId) {
      reservaId = await ultimaReservaDeCelular(ctx.externalId);
    }

    if (!reservaId) {
      return {
        result: { ok: false, motivo: "no se identifico la reserva" },
        reply_to_user:
          "Para pasarte los datos de pago necesito primero dejar tu reserva registrada. " +
          "¿Me confirmas el plan, la fecha y los datos de los huéspedes?",
      };
    }

    // --- 2. Los montos, siempre desde la base ---
    const cuenta: EstadoCuenta | null = await obtenerEstadoCuenta(reservaId);
    if (!cuenta) {
      console.error(`[enviar_datos_pago] No hay estado de cuenta para la reserva #${reservaId}`);
      return { result: { ok: false, motivo: "sin estado de cuenta" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    if (cuenta.total <= 0) {
      console.error(`[enviar_datos_pago] La reserva #${reservaId} no tiene valor cargado (total = ${cuenta.total})`);
      return { result: { ok: false, motivo: "reserva sin valor" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    if (cuenta.saldo <= 0) {
      return {
        result: { ok: true, reserva_id: reservaId, saldo: cuenta.saldo, ya_pagada: true },
        reply_to_user:
          `Tu reserva #${reservaId} ya figura sin saldo pendiente 🙌 ` +
          "Si necesitas el soporte del pago, el equipo de La Julita te lo hace llegar.",
      };
    }

    if (!boldConfigured) {
      console.error("[enviar_datos_pago] Falta BOLD_API_KEY: no se pueden generar links de pago.");
      return { result: { ok: false, motivo: "bold sin configurar" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    const saldo = Math.round(cuenta.saldo);
    const anticipo = anticipoSugerido(saldo);
    const referenciaTexto = `Reserva #${reservaId} La Julita`;

    // --- 3. Los dos links ---
    // 'total': monto cerrado por todo el saldo.
    // 'abono': monto abierto. En la base se registra el anticipo sugerido como valor de
    //          referencia; el valor real del abono lo fijara el webhook cuando exista (v2).
    const linkTotal = await conseguirLink(reservaId, "total", saldo, saldo, "CLOSE", `${referenciaTexto} - pago total`);
    const linkAbono = await conseguirLink(reservaId, "abono", anticipo, saldo, "OPEN", `${referenciaTexto} - abono`);

    if ("error" in linkTotal || "error" in linkAbono) {
      if ("error" in linkTotal) console.error(`[enviar_datos_pago] reserva #${reservaId}: ${linkTotal.error}`);
      if ("error" in linkAbono) console.error(`[enviar_datos_pago] reserva #${reservaId}: ${linkAbono.error}`);
      return { result: { ok: false, motivo: "no se pudo generar el link" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    // --- 4. El mensaje, exacto ---
    const lineaPagado = cuenta.pagado > 0 ? `Ya tienes abonado ${formatMoney(cuenta.pagado)}. ` : "";

    const reply =
      `Estos son los datos de pago de tu reserva #${reservaId} 🌿\n\n` +
      `Total: ${formatMoney(cuenta.total)}\n` +
      `${lineaPagado}Saldo pendiente: ${formatMoney(saldo)}\n` +
      `Para apartar la fecha con el 50%: ${formatMoney(anticipo)}\n\n` +
      `Pagar todo el saldo (${formatMoney(saldo)}):\n${linkTotal.url}\n\n` +
      `Abonar (tú digitas el monto, mínimo ${formatMoney(anticipo)}):\n${linkAbono.url}\n\n` +
      "⚠️ Estos links son para pago con cuenta DÉBITO, sin recargo. Si vas a pagar con tarjeta de " +
      "crédito escríbeme y el equipo te pasa el link correspondiente, que suma el 6%.\n\n" +
      "Apenas pagues, mándame el comprobante y el equipo de La Julita confirma tu reserva.";

    return {
      result: {
        ok: true,
        reserva_id: reservaId,
        total: cuenta.total,
        pagado: cuenta.pagado,
        saldo,
        anticipo_sugerido: anticipo,
        link_total: linkTotal.url,
        link_abono: linkAbono.url,
        links_reusados: linkTotal.reusado || linkAbono.reusado,
      },
      reply_to_user: reply,
    };
  },
};
