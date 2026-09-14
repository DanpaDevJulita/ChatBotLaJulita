import { getChannel } from "../../channels/registry.js";
import { insertMensaje } from "../db/mensajesRepo.js";
import { conversacionDeReserva, obtenerEstadoCuenta, resumenDeReserva } from "../db/pagosRepo.js";
import { politica } from "../db/politicasRepo.js";
import { cancelarRecontacto } from "../queue/recontactoQueue.js";
import { enviarSeguro } from "./enviar.js";
import { registrarMensajeDelBot } from "./runTurn.js";

/**
 * [2026-09-11] Le avisa al cliente, por su propio chat, que su pago entró — sin que tenga que
 * mandar ningún comprobante.
 *
 * Por qué existe: el webhook de Bold ya actualizaba la base (pago aprobado, saldo recalculado,
 * reserva confirmada), pero NADIE se lo decía al cliente. Desde su lado, pagar y no recibir
 * respuesta se siente como que el pago se perdió, y terminaba mandando el comprobante igual —
 * que era justamente lo que queríamos evitar.
 *
 * Reglas que se respetan acá:
 *   - Las cifras salen de la base (del resultado de fn_registrar_pago_aprobado), nunca de un
 *     cálculo hecho acá ni de lo que diga Bold en el payload.
 *   - El mensaje queda guardado en `mensajes` y en el historial en memoria del agente, para que
 *     si el cliente sigue escribiendo, el bot YA SEPA que le confirmó el pago y no lo repita ni
 *     le pregunte si va a pagar.
 *   - Se cancela la cadena de recontactos: perseguir con "¿seguís interesado?" a alguien que
 *     acaba de pagar es de las peores cosas que puede hacer un bot.
 *
 * Es "mejor esfuerzo": si algo falla (no se pudo resolver el chat, WhatsApp caído), se loguea y
 * ya — el pago YA quedó registrado en la base, que es lo que no se puede perder. El equipo lo ve
 * igual en el panel.
 */
export interface DatosDelPago {
  reservaId: number;
  /** Lo que el cliente acaba de pagar, según la base. */
  totalPagado?: number;
  saldoPendiente?: number;
  estadoPago?: string;
  /**
   * [2026-09-11] ¿El cupo está asegurado en LobbyPMS? Si no se pasa, se asume que SÍ (es el caso
   * normal: el pago entra dentro de los minutos del bloqueo, que sigue vigente).
   *
   * Se pasa en false cuando el pago llegó tarde y el cupo NO se pudo volver a tomar. En ese caso
   * el mensaje NO confirma nada: le dice que el pago entró y que estamos validando la fecha. La
   * regla del equipo es explícita — no se le confirma una reserva al cliente hasta tenerla en las
   * dos partes, nuestra base Y LobbyPMS. Confirmar de más significa un cliente llegando al
   * glamping sin dónde alojarse.
   */
  cupoAsegurado?: boolean;
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function fechaEnPalabras(fechaISO: string | null | undefined): string | null {
  const m = (fechaISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const mes = MESES[Number(m[2]) - 1];
  return mes ? `${Number(m[3])} de ${mes}` : null;
}

function primerNombre(nombreCompleto: string | null | undefined): string | null {
  const primero = (nombreCompleto ?? "").trim().split(/\s+/)[0];
  return primero ? primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase() : null;
}

/**
 * [2026-09-14] Pedido de Daniel: seguido de CONFIRMAR una reserva (no de la de "estoy validando
 * la fecha" — esa todavía no es una confirmación), ofrecer adicionales sin sonar cansón ni
 * necesitado, y decirle que estamos felices de recibirlo.
 *
 * Por qué es una sola línea genérica y no un listado armado a mano contra lo que YA trae el
 * plan: no hay en la base ninguna relación estructurada "qué adicionales incluye cada plan" (los
 * planes solo traen precio y una descripción en texto libre, ver sql/schema.sql PARTE 2) — armar
 * ese cruce a mano sería inventar una regla que no existe. La invitación abierta ("si quieres
 * sumarle algo, pregúntame") deja que el cliente mismo filtre: si ya lo tiene incluido, no lo va
 * a pedir. Se reusa acá y en `verificar_pago` (pago.ts) para que el cierre suene igual sin
 * importar por cuál de los 4 caminos se confirmó el pago.
 */
export const CIERRE_CONFIRMACION =
  "\n\nEstamos felices de recibirte pronto en La Julita 💚 Si quieres sumarle algo especial a tu estadía " +
  "(desayuno especial, jacuzzi, decoración, transporte u otra sorpresa) solo cuéntame y te paso los precios " +
  "— sin ningún compromiso.";

/** Arma el mensaje exacto. Separado para poder probarlo sin tocar WhatsApp ni la base. */
export function textoDeConfirmacion(params: {
  nombre: string | null;
  plan: string | null;
  fecha: string | null;
  pagado: number;
  saldo: number;
  cupoAsegurado?: boolean;
  /**
   * [2026-09-13] El texto oficial de cuándo se paga el 50% restante, ya leído de la tabla
   * `politicas` por quien llama (esta función se mantiene sincrónica a propósito, para poder
   * probarla sin base). Si viene null, el mensaje simplemente no lo menciona.
   */
  politicaSaldo?: string | null;
}): string {
  const quePlan = params.plan ? ` del ${params.plan}` : "";
  const cuando = params.fecha ? ` para el ${params.fecha}` : "";

  // [2026-09-11] Cupo NO asegurado (pago tardío, la fecha ya se había soltado): se le agradece el
  // pago y se le dice la verdad — que estamos validando la fecha. NADA de "queda confirmada".
  if (params.cupoAsegurado === false) {
    const saludo = params.nombre ? `¡Gracias, ${params.nombre}! 💚` : "¡Gracias! 💚";
    return (
      `${saludo} Ya nos entró tu pago de ${formatMoney(params.pagado)}.\n\n` +
      `Como entró un poquito después del tiempo que tenía apartado, estoy confirmando con el equipo que la ` +
      `fecha${quePlan ? ` ${quePlan.trim()}` : ""}${cuando} siga disponible. Te confirmo en un ratico, apenas lo tenga ` +
      "seguro 🙏\n\nNo necesitas mandarme el comprobante, ya lo vi de mi lado 😊"
    );
  }

  const saludo = params.nombre ? `¡Confirmado, ${params.nombre}! 💚` : "¡Confirmado! 💚";
  const quedaSaldo = params.saldo > 0;

  const cuerpo = quedaSaldo
    ? `Ya nos entró tu abono de ${formatMoney(params.pagado)} y tu reserva${quePlan}${cuando} queda apartada ✅\n\n` +
      `Queda un saldo de ${formatMoney(params.saldo)}.` +
      (params.politicaSaldo ? `\n${params.politicaSaldo}` : "") +
      "\nTe lo recuerdo más cerca de la fecha 😊"
    : `Ya nos entró tu pago de ${formatMoney(params.pagado)} y tu reserva${quePlan}${cuando} queda confirmada ✅\n\n` +
      "No queda saldo pendiente 🙌";

  return (
    `${saludo} ${cuerpo}\n\nNo necesitas mandarme el comprobante, ya lo vi de mi lado 😊 Cualquier cosa que necesites ` +
    `antes de tu llegada, escríbeme por acá.${CIERRE_CONFIRMACION}`
  );
}

export async function avisarPagoConfirmado(datos: DatosDelPago): Promise<void> {
  const destino = await conversacionDeReserva(datos.reservaId);
  if (!destino) {
    console.warn(
      `[avisarPago] reserva #${datos.reservaId}: no pude resolver a qué chat escribirle (el cliente no tiene ` +
        "celular cargado, o no hay conversación con ese número). El pago YA quedó registrado; el aviso lo da el equipo."
    );
    return;
  }

  const key = `${destino.canal}:${destino.externalId}`;

  const [cuenta, resumen] = await Promise.all([
    obtenerEstadoCuenta(datos.reservaId),
    resumenDeReserva(datos.reservaId),
  ]);

  // Las cifras: lo que diga la base. `totalPagado` del resultado del webhook es el acumulado de
  // la reserva; si por lo que sea no vino, se cae al estado de cuenta.
  const pagado = datos.totalPagado ?? cuenta?.pagado ?? 0;
  const saldo = datos.saldoPendiente ?? cuenta?.saldo ?? 0;
  if (pagado <= 0) {
    console.warn(`[avisarPago] reserva #${datos.reservaId}: no tengo un monto pagado válido, no le escribo nada.`);
    return;
  }

  const texto = textoDeConfirmacion({
    nombre: primerNombre(cuenta?.cliente),
    plan: resumen?.plan ?? null,
    fecha: fechaEnPalabras(resumen?.fecha ?? cuenta?.fecha_checkin),
    pagado,
    saldo,
    cupoAsegurado: datos.cupoAsegurado,
    // El texto oficial de cuándo se paga el saldo (tabla `politicas`). Solo hace falta si queda
    // saldo; si la base no lo tiene cargado, el mensaje sale igual, sin esa línea.
    politicaSaldo: saldo > 0 ? await politica("saldo_pendiente") : null,
  });

  let adapter;
  try {
    adapter = getChannel(destino.canal);
  } catch (err) {
    console.error(`[avisarPago] ${key}: no hay adaptador registrado para ese canal:`, err);
    return;
  }

  const entregado = await enviarSeguro(adapter, destino.externalId, texto, key);
  if (!entregado) {
    console.error(`[avisarPago] ${key}: el pago quedó registrado pero NO pude entregarle el aviso al cliente.`);
    return;
  }

  // Que el agente sepa que ya se lo confirmó: si el cliente escribe después, el bot no puede
  // preguntarle si va a pagar ni volver a mandarle el link.
  registrarMensajeDelBot(destino.canal, destino.externalId, texto);
  await insertMensaje({
    canal: destino.canal,
    external_id: destino.externalId,
    role: "assistant",
    content: texto,
    agent_name: "pago-confirmado",
  });

  // Ya pagó: no se lo persigue más con la cadena de recontactos.
  await cancelarRecontacto(destino.canal, destino.externalId);

  console.log(`[avisarPago] ${key}: le confirmé el pago de la reserva #${datos.reservaId} (saldo ${saldo}).`);
}
