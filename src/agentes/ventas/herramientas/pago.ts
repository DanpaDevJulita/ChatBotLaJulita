import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import {
  obtenerEstadoCuenta,
  ultimaReservaDeCelular,
  pagoPendienteDe,
  crearPagoPendiente,
  guardarLinkDeBold,
  anularPagoPendiente,
  resumenDeReserva,
  type EstadoCuenta,
  type TipoPago,
} from "../../../core/db/pagosRepo.js";
import { bloqueoPendienteDe } from "../../../core/db/bloqueosRepo.js";
import { verificarPagoEnBold } from "../../../core/pipeline/verificarPagoEnBold.js";
import { cancelarSeguimientoDePago } from "../../../core/queue/bloqueoQueue.js";
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
 * LINK. No confirma pagos ella misma ni consulta si el dinero entro — eso ahora lo hace el
 * webhook de Bold (POST /webhooks/bold en web/server.ts -> registrarPagoAprobado en
 * pagosRepo.ts -> fn_registrar_pago_aprobado en la base), agregado el 2026-09-11 con la misma
 * logica de firma que el bot base (agente-ycloud-main / "Sebas Raider"). Mientras ese webhook
 * no este probado con un pago real, el equipo sigue verificando en el panel de Bold como
 * respaldo.
 *
 * [2026-09-11] UN SOLO LINK, de monto ABIERTO. Antes se mandaban dos (uno cerrado por el total y
 * uno abierto para abonar) porque Bold no tiene una modalidad intermedia: un link es de monto
 * CERRADO (CLOSE, el huesped no lo puede cambiar) o ABIERTO (OPEN, el huesped digita cuanto
 * paga). El equipo decidio mandar solo el ABIERTO: ahi el cliente elige si abona el 50% para
 * apartar la fecha o paga el total, que es exactamente lo que se le ofrece. Dos links para lo
 * mismo confundian.
 *
 * [2026-09-11] Tampoco se ofrece mas el QR (llave Bre-B) ni se menciona el 6% de la tarjeta de
 * credito: por decision del equipo, TODOS los pagos por WhatsApp van por este link, que es de
 * cuenta DEBITO y no suma recargo. Ya no se le pregunta al cliente que medio prefiere.
 *
 * [2026-09-11] Este mensaje es el UNICO que ve el cliente cuando termina de dar sus datos: el
 * turno encadena `registrar_datos_reserva` y despues esta herramienta, y como aca
 * `permitirRedaccion` va en false, lo que sale es este texto exacto. Por eso incluye tambien el
 * resumen de la reserva y el aviso de los minutos que queda apartado el cupo.
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

/**
 * El 50% exacto del saldo, en pesos enteros (Bold no acepta decimales).
 *
 * [2026-09-11] Antes esto redondeaba a miles "para no mandar un anticipo de $348.512", y ahí
 * había un error que le costaba plata al cliente: `Math.round(2.5)` en JavaScript sube a 3, así
 * que con un plan de $5.000 el 50% ($2.500) se convertía en $3.000 — le cobrábamos MÁS de lo que
 * le habíamos prometido en el mismo mensaje. Lo detectó Daniel probando el 2026-09-11.
 *
 * Ahora no se redondea a miles: se toma el 50% exacto y se trunca hacia abajo. Que el anticipo
 * quede en $284.500 no le molesta a nadie; que le cobremos $500 de más, sí. Truncar hacia abajo
 * (y no al más cercano) garantiza que el abono NUNCA pase del 50% prometido.
 */
function anticipoSugerido(saldo: number): number {
  const exacto = Math.floor(saldo * PORCENTAJE_ANTICIPO);
  // Nunca más que el saldo, y nunca 0 (una reserva de $1 no se puede partir en dos).
  return Math.min(Math.max(exacto, 1), Math.floor(saldo));
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
    // [2026-09-11] El monto va en el mensaje a proposito: Bold rechaza montos por debajo de su
    // minimo, y con precios de prueba muy bajos (ej. un plan puesto en $500 para probar) el
    // error de Bold solo se entiende si al lado se ve por cuanto se pidio el link.
    return {
      error:
        `Bold no devolvio el link ${tipo} (modalidad ${modalidad}, monto ${montoDelLink}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await guardarLinkDeBold(creado.id_pago, link.paymentLink, link.url);
  return { url: link.url, reusado: false };
}

/** Mensaje unico para cuando algo falla por dentro: el cliente nunca ve un error tecnico. */
const DERIVAR_AL_EQUIPO =
  "Déjame confirmar un detalle del pago con el equipo de La Julita y en un momento te paso los datos 🙏";

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "2026-09-11" -> "11 de septiembre". Si no se entiende la fecha, se devuelve tal cual. */
function fechaEnPalabras(fechaISO: string | null): string | null {
  const m = (fechaISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return fechaISO;
  const mes = MESES[Number(m[2]) - 1];
  return mes ? `${Number(m[3])} de ${mes}` : fechaISO;
}

/** Solo el primer nombre, para saludar como lo hace el equipo. */
function primerNombre(nombreCompleto: string | null): string | null {
  const primero = (nombreCompleto ?? "").trim().split(/\s+/)[0];
  return primero ? primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase() : null;
}

/** "Marcela y Efraín" / "Marcela, Efraín y Ana" */
function listaDeNombres(nombres: string[]): string {
  const primeros = nombres.map((n) => primerNombre(n)).filter((n): n is string => Boolean(n));
  if (primeros.length === 0) return "";
  if (primeros.length === 1) return primeros[0];
  return `${primeros.slice(0, -1).join(", ")} y ${primeros[primeros.length - 1]}`;
}

/**
 * Minutos que le quedan al bloqueo de ESTA conversación, o null si no hay ninguno vigente. Se
 * consulta en vez de dar por hecho los 10 minutos: si el cliente pide los datos de pago más
 * tarde (sin bloqueo activo), prometerle un cupo apartado sería mentirle.
 */
async function minutosDeCupoApartado(canal: string, externalId: string): Promise<number | null> {
  try {
    const bloqueo = await bloqueoPendienteDe(canal, externalId);
    if (!bloqueo) return null;
    const restan = Math.round((new Date(bloqueo.expira_en).getTime() - Date.now()) / 60_000);
    return restan > 0 ? restan : null;
  } catch (err) {
    console.error("[enviar_datos_pago] no pude leer el bloqueo vigente (sigo sin el aviso):", err);
    return null;
  }
}

/**
 * [2026-09-11] Todo lo que hace falta para cobrar una reserva, reunido en un solo lugar: lo usan
 * las DOS herramientas de pago (la que pregunta cómo quiere pagar y la que manda el link), así
 * los montos se calculan una sola vez y de una sola manera — siempre desde la base.
 */
interface DatosDeCobro {
  reservaId: number;
  cuenta: EstadoCuenta;
  /** Lo que falta por pagar, redondeado. Es el valor de la opción "pago total". */
  saldo: number;
  /** 50% del saldo, redondeado a miles. Es el valor de la opción "abono". */
  anticipo: number;
}

/** Lo que devuelve reunirDatosDeCobro cuando NO se puede cobrar (ya trae la respuesta al cliente). */
interface CobroImposible {
  fallo: { result: unknown; reply_to_user: string };
}

async function reunirDatosDeCobro(
  reservaIdPedido: number | undefined,
  ctx: ToolContext
): Promise<DatosDeCobro | CobroImposible> {
  // --- 1. De qué reserva estamos hablando ---
  let reservaId = Number(reservaIdPedido) || null;
  if (!reservaId) {
    reservaId = await ultimaReservaDeCelular(ctx.externalId);
  }

  if (!reservaId) {
    // [2026-09-11] Antes acá se le pedían los datos al cliente otra vez ("necesito primero
    // dejar tu reserva registrada..."), y eso generaba un bucle real: el cliente YA los había
    // dado, el modelo obedecía ese texto y le volvía a preguntar las edades y los documentos.
    // Si no aparece la reserva es un problema NUESTRO (la fila de `reservas` no se creó, ver
    // registrar_datos_reserva), no del cliente: se deriva al equipo y queda en los logs.
    console.error(
      `[pagos] No encontré ninguna reserva para ${ctx.externalId} (ni por reserva_id ni por ` +
        "celular). Si el cliente acaba de dar sus datos, lo más probable es que la fila de `reservas` no " +
        "se haya creado: revisar que sql/pagos-migracion-reservas.sql esté corrido (deja `domo_id` opcional)."
    );
    return {
      fallo: {
        result: {
          ok: false,
          motivo: "no se identifico la reserva",
          para_el_modelo:
            "NO le pidas los datos al cliente otra vez ni vuelvas a llamar a registrar_datos_reserva: ya los dio.",
        },
        reply_to_user: DERIVAR_AL_EQUIPO,
      },
    };
  }

  // --- 2. Los montos, siempre desde la base ---
  const cuenta: EstadoCuenta | null = await obtenerEstadoCuenta(reservaId);
  if (!cuenta) {
    console.error(`[pagos] No hay estado de cuenta para la reserva #${reservaId}`);
    return { fallo: { result: { ok: false, motivo: "sin estado de cuenta" }, reply_to_user: DERIVAR_AL_EQUIPO } };
  }

  if (cuenta.total <= 0) {
    console.error(`[pagos] La reserva #${reservaId} no tiene valor cargado (total = ${cuenta.total})`);
    return { fallo: { result: { ok: false, motivo: "reserva sin valor" }, reply_to_user: DERIVAR_AL_EQUIPO } };
  }

  if (cuenta.saldo <= 0) {
    return {
      fallo: {
        result: { ok: true, reserva_id: reservaId, saldo: cuenta.saldo, ya_pagada: true },
        reply_to_user:
          `Tu reserva #${reservaId} ya figura sin saldo pendiente 🙌 ` +
          "Si necesitas el soporte del pago, el equipo de La Julita te lo hace llegar.",
      },
    };
  }

  const saldo = Math.round(cuenta.saldo);
  return { reservaId, cuenta, saldo, anticipo: anticipoSugerido(saldo) };
}

/**
 * El resumen de la reserva con el que arranca el mensaje ("Tu reserva del PLAN X para el 15 de
 * septiembre quedó registrada por $760.000, con Marcela y Efraín anotados").
 */
async function encabezadoDeReserva(datos: DatosDeCobro): Promise<{ texto: string; nombre: string | null; resumen: Awaited<ReturnType<typeof resumenDeReserva>> }> {
  const resumen = await resumenDeReserva(datos.reservaId);
  const nombre = primerNombre(datos.cuenta.cliente);
  const fecha = fechaEnPalabras(resumen?.fecha ?? datos.cuenta.fecha_checkin);
  const acompanantes = listaDeNombres(resumen?.acompanantes ?? []);

  const saludo = nombre ? `¡Listo, ${nombre}! 💚 ` : "¡Listo! 💚 ";
  const quePlan = resumen?.plan ? ` del ${resumen.plan}` : "";
  const cuando = fecha ? ` para el ${fecha}` : "";
  const conQuien = acompanantes ? `, con ${acompanantes} anotado${(resumen?.acompanantes.length ?? 0) > 1 ? "s" : ""}` : "";
  const lineaPagado = datos.cuenta.pagado > 0 ? `\nYa tienes abonado ${formatMoney(datos.cuenta.pagado)}.` : "";

  return {
    texto:
      `${saludo}Tu reserva${quePlan}${cuando} quedó registrada por ${formatMoney(datos.cuenta.total)} (sin IVA)` +
      `${conQuien}.${lineaPagado}`,
    nombre,
    resumen,
  };
}

/**
 * La pregunta exacta que se le hace al cliente antes de generarle el link.
 *
 * [2026-09-11] Va escrita como la escribiría una asesora por WhatsApp, NO como un menú de
 * opciones numeradas ("marque 1, marque 2"): nada delata más rápido que del otro lado hay un
 * bot. Por eso no se le pide que conteste un número — se le ofrecen las dos posibilidades en
 * una frase y contesta como quiera ("el 50", "abono", "lo dejo pago completo"). Interpretar esa
 * respuesta es justamente lo que el modelo sabe hacer bien; lo que no se le deja al modelo son
 * las CIFRAS, que salen de la base y viajan en este texto literal.
 */
function textoDeLaPregunta(datos: DatosDeCobro, encabezado: string, minutos: number | null): string {
  const hayAbonoPrevio = datos.cuenta.pagado > 0;
  const ofrecimiento = hayAbonoPrevio
    ? `Puedes abonar el 50% de lo que queda, que son ${formatMoney(datos.anticipo)}, o dejarla al día ` +
      `pagando los ${formatMoney(datos.saldo)} completos`
    : `Para apartar la fecha puedes abonar el 50%, que son ${formatMoney(datos.anticipo)}, o dejarla paga ` +
      `completa con los ${formatMoney(datos.saldo)}`;

  return (
    `${encabezado}\n\n` +
    `${ofrecimiento} — como te quede más cómodo 😊\n\n` +
    "Cuéntame cuál prefieres y te paso el link enseguida 💚" +
    (minutos
      ? `\n\n⏳ El cupo te queda apartado por ${minutos} ${minutos === 1 ? "minuto" : "minutos"} mientras decides.`
      : "")
  );
}

/**
 * preguntar_forma_de_pago — [2026-09-11] el paso que va ANTES del link.
 *
 * Por qué es una herramienta aparte y no un parámetro de `enviar_datos_pago`: el link ahora sale
 * con el monto YA FIJADO (modalidad CLOSE en Bold), así que mandarlo sin que el cliente haya
 * elegido sería cobrarle un valor que nunca aceptó. Al ser una herramienta distinta, el turno que
 * sigue a `registrar_datos_reserva` NO PUEDE generar un link ni aunque el modelo quiera: lo único
 * que esta herramienta sabe hacer es preguntar. (Mismo criterio que el resto del módulo: lo que
 * no puede fallar no se deja en manos de la redacción del modelo.)
 *
 * Los dos montos salen de la base (v_estado_cuenta), nunca de una cuenta del modelo, y el texto
 * va literal (`permitirRedaccion: false`).
 */
export const preguntarFormaDePagoTool: ToolDefinition = {
  name: "preguntar_forma_de_pago",
  permitirRedaccion: false,
  description:
    "Le pregunta al cliente si quiere abonar el 50% para apartar la fecha o pagar el valor total, mostrándole los DOS montos exactos. Llamala SIEMPRE justo después de que registrar_datos_reserva devuelva ok con un reserva_id, y también cuando el cliente diga que quiere pagar pero todavía no haya elegido entre abono y total. Es el paso previo OBLIGATORIO a enviar_datos_pago: el link sale con el valor ya fijado, así que primero el cliente tiene que elegir. NO calcules vos los montos ni los repitas: esta herramienta los manda tal cual.",
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
    const datos = await reunirDatosDeCobro(args?.reserva_id, ctx);
    if ("fallo" in datos) return datos.fallo;

    const { texto: encabezado, resumen } = await encabezadoDeReserva(datos);
    const minutos = await minutosDeCupoApartado(ctx.channel, ctx.externalId);

    return {
      result: {
        ok: true,
        reserva_id: datos.reservaId,
        plan: resumen?.plan ?? null,
        fecha: resumen?.fecha ?? null,
        total: datos.cuenta.total,
        pagado: datos.cuenta.pagado,
        saldo: datos.saldo,
        opciones: { abono: datos.anticipo, total: datos.saldo },
        minutos_de_bloqueo: minutos,
        siguiente_paso:
          "Espera la respuesta del cliente, que va a venir con sus palabras (no con un número): " +
          '"el 50", "abono", "aparto la fecha" -> modalidad="abono"; "completa", "todo", "pago total", ' +
          '"la dejo paga" -> modalidad="total". Con eso llamá enviar_datos_pago con este mismo reserva_id. ' +
          'Si contesta algo que no aclara cuál quiere ("sí", "dale", "ok"), volvé a preguntárselo con ' +
          "naturalidad — NO elijas vos por él.",
      },
      reply_to_user: textoDeLaPregunta(datos, encabezado, minutos),
    };
  },
};

export const enviarDatosPagoTool: ToolDefinition = {
  name: "enviar_datos_pago",
  // El texto va LITERAL: montos y links no se reformulan.
  permitirRedaccion: false,
  description:
    "Manda el link de pago de una reserva ya registrada, CON EL VALOR YA FIJADO. Solo se llama DESPUÉS de que el cliente eligió entre abonar el 50% o pagar el total (se lo pregunta preguntar_forma_de_pago): pasale modalidad=\"abono\" o modalidad=\"total\" según lo que el cliente haya dicho EXPLÍCITAMENTE en el chat. Si todavía no eligió, no la llames — llamá preguntar_forma_de_pago. Nunca adivines la modalidad. Pasale también el reserva_id que devolvió registrar_datos_reserva. NO confirma pagos ni dice que una reserva quedó pagada: eso lo verifica el equipo.",
  parameters: {
    type: "object",
    properties: {
      reserva_id: {
        type: "integer",
        description:
          "El número de reserva que devolvió registrar_datos_reserva en esta misma conversación. Si no lo tienes, no lo inventes: deja el campo vacío y se busca por el celular de quien escribe.",
      },
      modalidad: {
        type: "string",
        enum: ["abono", "total"],
        description:
          'Qué eligió el cliente: "abono" (el 50% para apartar la fecha) o "total" (todo el valor). Tiene que salir de algo que el cliente DIJO con sus palabras en este chat — "el 50", "abono", "aparto la fecha", "lo mínimo" son abono; "completa", "todo", "pago total", "la dejo paga" son total. Si contestó algo que no aclara cuál quiere ("sí", "dale", "ok"), NO llames esta herramienta: preguntáselo otra vez.',
      },
    },
    required: ["modalidad"],
  },
  handler: async (args: { reserva_id?: number; modalidad?: string }, ctx: ToolContext) => {
    const datos = await reunirDatosDeCobro(args?.reserva_id, ctx);
    if ("fallo" in datos) return datos.fallo;

    const { reservaId, cuenta, saldo, anticipo } = datos;

    // --- Sin elección explícita del cliente NO hay link ---
    // El link sale con el monto fijado, así que si el modelo la llamó sin modalidad (o con una
    // que no existe) NO se adivina: se le devuelve la pregunta al cliente, que es lo que
    // correspondía hacer. Es la misma pregunta exacta de preguntar_forma_de_pago.
    const modalidad = args?.modalidad === "abono" || args?.modalidad === "total" ? args.modalidad : null;
    if (!modalidad) {
      console.warn(
        `[enviar_datos_pago] reserva #${reservaId}: me llamaron sin modalidad válida ` +
          `(${JSON.stringify(args?.modalidad)}) — le pregunto al cliente en vez de mandarle un link a ciegas.`
      );
      const { texto: encabezado } = await encabezadoDeReserva(datos);
      const minutosAhora = await minutosDeCupoApartado(ctx.channel, ctx.externalId);
      return {
        result: {
          ok: false,
          motivo: "el cliente todavía no eligió cómo pagar",
          opciones: { abono: anticipo, total: saldo },
          siguiente_paso: "Espera que el cliente elija y recién ahí llamá esta herramienta con la modalidad.",
        },
        reply_to_user: textoDeLaPregunta(datos, encabezado, minutosAhora),
      };
    }

    if (!boldConfigured) {
      console.error("[enviar_datos_pago] Falta BOLD_API_KEY: no se pueden generar links de pago.");
      return { result: { ok: false, motivo: "bold sin configurar" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    // --- El link, con el monto YA FIJADO segun lo que eligio el cliente ---
    // [2026-09-11] Antes iba UN link de monto ABIERTO (OPEN) y el cliente digitaba ahi cuanto
    // pagaba. Ahora se le pregunta antes (preguntar_forma_de_pago) y el link sale CERRADO
    // (CLOSE) con el valor exacto de lo que eligio: menos pasos para el, y el monto que entra
    // por Bold coincide siempre con lo que la reserva espera cobrar.
    const montoDelLink = modalidad === "abono" ? anticipo : saldo;
    const referenciaTexto = `Reserva #${reservaId} La Julita`;
    const queEs = modalidad === "abono" ? "abono del 50%" : "pago total";

    // Si habia un link pendiente de la OTRA modalidad (el cliente cambio de idea), se anula:
    // dejar dos links vivos por la misma reserva es como se cobra dos veces sin querer.
    const otraModalidad: TipoPago = modalidad === "abono" ? "total" : "abono";
    const pendienteDeLaOtra = await pagoPendienteDe(reservaId, otraModalidad);
    if (pendienteDeLaOtra) {
      console.log(
        `[enviar_datos_pago] reserva #${reservaId}: el cliente cambio a "${modalidad}", anulo el link ` +
          `pendiente de "${otraModalidad}" (pago #${pendienteDeLaOtra.id}).`
      );
      await anularPagoPendiente(pendienteDeLaOtra.id);
    }

    const link = await conseguirLink(
      reservaId,
      modalidad,
      montoDelLink,
      montoDelLink,
      "CLOSE",
      `${referenciaTexto} - ${queEs}`
    );

    if ("error" in link) {
      console.error(`[enviar_datos_pago] reserva #${reservaId}: ${link.error}`);
      return { result: { ok: false, motivo: "no se pudo generar el link" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    // --- El mensaje, exacto ---
    const { texto: encabezado, nombre, resumen } = await encabezadoDeReserva(datos);
    const minutos = await minutosDeCupoApartado(ctx.channel, ctx.externalId);
    const saludo = nombre ? `¡Perfecto, ${nombre}! 💚 ` : "¡Perfecto! 💚 ";

    // [2026-09-11] Escrito como un mensaje de una persona, no como un comprobante: sin menús ni
    // etiquetas entre paréntesis. El monto ya va fijado en el link, así que se lo decimos con
    // naturalidad ("solo tienes que confirmarlo") en vez de explicarle el mecanismo.
    const reply =
      `${saludo}Acá te dejo el link para ${modalidad === "abono" ? "el abono" : "el pago completo"} ` +
      `de ${formatMoney(montoDelLink)}:\n\n` +
      `${link.url}\n\n` +
      "Ya va con el valor puesto, así que solo tienes que confirmarlo 🙌\n\n" +
      (modalidad === "abono"
        ? `Los otros ${formatMoney(saldo - montoDelLink)} quedan pendientes y se pagan según las condiciones ` +
          "del plan, así que de eso hablamos más adelante.\n\n"
        : "") +
      (minutos
        ? `⏳ El cupo te queda apartado por ${minutos} ${minutos === 1 ? "minuto" : "minutos"} mientras confirmas el pago.\n\n`
        : "") +
      "Apenas pagues, mándame el comprobante y el equipo de La Julita confirma tu reserva 💚";

    return {
      result: {
        ok: true,
        reserva_id: reservaId,
        modalidad,
        plan: resumen?.plan ?? null,
        fecha: resumen?.fecha ?? null,
        total: cuenta.total,
        pagado: cuenta.pagado,
        saldo,
        valor_del_link: montoDelLink,
        anticipo_sugerido: anticipo,
        link_pago: link.url,
        link_reusado: link.reusado,
        minutos_de_bloqueo: minutos,
        encabezado_reserva: encabezado,
      },
      reply_to_user: reply,
    };
  },
};

/**
 * verificar_pago — [2026-09-11] "ya pagué": el bot le PREGUNTA a Bold en vez de pedir comprobante.
 *
 * Por qué existe, además del webhook: el webhook es el camino normal y el que confirma solo, pero
 * depende de que Bold logre entregarnos la notificación. Su propia documentación admite demoras de
 * hasta 10 minutos en links de pago, y si en el panel no hay llaves de integración habilitadas no
 * manda nada. Mientras tanto el cliente ya pagó, está esperando, y lo único que se le ocurría al
 * bot era pedirle el comprobante — justo lo que queremos evitar.
 *
 * Los dos caminos (webhook y esta consulta) terminan en la MISMA función de base,
 * `fn_registrar_pago_aprobado`, que es idempotente: si el webhook ya lo había registrado, esto no
 * duplica nada, solo lo confirma.
 *
 * Lo que NO hace: dar por pagado algo que no pudo verificar. Si Bold no responde, o el link sigue
 * activo, se lo dice al cliente con todas las letras. Un "sí, ya lo vi" falso es mucho peor que un
 * "todavía no me aparece".
 */
export const verificarPagoTool: ToolDefinition = {
  name: "verificar_pago",
  permitirRedaccion: false,
  description:
    "Le pregunta a Bold, en vivo, si el pago de una reserva ya entró. Llamala SIEMPRE que el cliente diga que ya pagó, que hizo la transferencia, que mandó el comprobante, o pregunte si ya le llegó el pago — ANTES de pedirle cualquier comprobante o de decirle que el equipo verifica. Pasale el reserva_id si lo tenés; si no, se busca por el celular de quien escribe. Si el pago entró, esta herramienta lo deja registrado y le confirma la reserva al cliente. NO le pidas el comprobante: para eso está esta herramienta.",
  parameters: {
    type: "object",
    properties: {
      reserva_id: {
        type: "integer",
        description:
          "El número de reserva de esta conversación, si lo tenés. Si no, dejalo vacío y se busca por el celular.",
      },
    },
    required: [],
  },
  handler: async (args: { reserva_id?: number }, ctx: ToolContext) => {
    let reservaId = Number(args?.reserva_id) || null;
    if (!reservaId) reservaId = await ultimaReservaDeCelular(ctx.externalId);

    if (!reservaId) {
      console.error(`[verificar_pago] No encontré reserva para ${ctx.externalId}`);
      return { result: { ok: false, motivo: "no se identifico la reserva" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    // La consulta a Bold vive en core/pipeline/verificarPagoEnBold.ts porque la comparte con la
    // liberación automática del cupo (bloqueo.ts): las dos tienen que decidir igual.
    const v = await verificarPagoEnBold(reservaId);

    if (v.yaSinSaldo) {
      return {
        result: { ok: true, reserva_id: reservaId, ya_estaba_pagada: true, pagado: v.montoPagado },
        reply_to_user:
          `¡Sí, ya está! 💚 Tu reserva #${reservaId} figura pagada por ${formatMoney(v.montoPagado ?? 0)} y sin saldo pendiente. ` +
          "No necesitas mandarme nada más 😊",
      };
    }

    if (v.sinLinksPendientes) {
      console.warn(`[verificar_pago] reserva #${reservaId}: no hay pagos pendientes con link que consultar.`);
      return { result: { ok: false, motivo: "sin links pendientes que consultar" }, reply_to_user: DERIVAR_AL_EQUIPO };
    }

    if (v.pagado) {
      // [2026-09-13] El cliente mismo confirmó que ya pagó — no hace falta que el bot le siga
      // preguntando a Bold por su cuenta más tarde (los chequeos de los 3/7 min, ni el de antes
      // de liberar). Best-effort: si esto falla, esos chequeos igual son inofensivos (no le
      // vuelven a escribir nada al cliente si ya está confirmado).
      void bloqueoPendienteDe(ctx.channel, ctx.externalId)
        .then((b) => (b ? cancelarSeguimientoDePago(b.id) : undefined))
        .catch((err) => console.error("[verificar_pago] no pude cancelar el seguimiento pendiente del bloqueo:", err));

      const saldo = v.saldoPendiente ?? 0;
      const pagado = v.montoPagado ?? 0;
      const [resumen, cuenta] = await Promise.all([resumenDeReserva(reservaId), obtenerEstadoCuenta(reservaId)]);
      const nombre = primerNombre(cuenta?.cliente ?? null);
      const saludo = nombre ? `¡Confirmado, ${nombre}! 💚 ` : "¡Confirmado! 💚 ";
      const quePlan = resumen?.plan ? ` del ${resumen.plan}` : "";
      const cuando = fechaEnPalabras(resumen?.fecha ?? cuenta?.fecha_checkin ?? null);
      const fecha = cuando ? ` para el ${cuando}` : "";

      return {
        result: {
          ok: true,
          reserva_id: reservaId,
          verificado_contra: "bold",
          ya_estaba_registrado: v.yaEstabaRegistrado,
          pagado,
          saldo,
          estado_pago: v.estadoPago,
        },
        reply_to_user:
          `${saludo}Acabo de verificarlo con el banco: ya nos entró tu pago de ${formatMoney(pagado)} y tu reserva` +
          `${quePlan}${fecha} queda ${saldo > 0 ? "apartada ✅" : "confirmada ✅"}.` +
          (saldo > 0
            ? `\n\nQueda un saldo de ${formatMoney(saldo)}, que se paga según las condiciones del plan.`
            : "\n\nNo queda saldo pendiente 🙌") +
          "\n\nNo necesitas mandarme el comprobante 😊",
      };
    }

    return {
      result: { ok: true, reserva_id: reservaId, pagado: false, estados: v.estados, no_se_pudo_consultar: v.noSePudoConsultar },
      reply_to_user: v.noSePudoConsultar
        ? "No pude confirmarlo con el banco en este momento 🙏 Dame unos minutos y lo reviso de nuevo, o si prefieres le paso el dato al equipo de La Julita para que lo verifiquen."
        : "Todavía no me aparece el pago registrado 😕 A veces el banco se demora unos minutos en confirmarlo. Si ya lo hiciste, dame unos minutos y lo vuelvo a revisar.",
    };
  },
};
