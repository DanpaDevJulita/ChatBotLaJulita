import axios, { AxiosInstance } from "axios";
import crypto from "node:crypto";

/**
 * Cliente de Bold para el Glamping La Julita.
 *
 * Adaptado del bot base (agente-ycloud). Cambios respecto al original:
 *  - Se elimino todo el camino de "Boton de pagos" (calcularFirmaIntegridad,
 *    consultarEstadoVenta, BOLD_PAYMENTS_BASE_URL). El propio codigo base lo
 *    marcaba como "queda de respaldo sin usar": Bold hospeda el checkout con
 *    la API de Link de pagos y no necesitamos pagina propia.
 *  - crearLinkDePago ya NO asume un precio fijo de catalogo: el monto llega
 *    calculado desde la reserva (noches x tarifa x temporada + adicionales),
 *    y se identifica si es anticipo, saldo o pago total.
 *  - [2026-09-10] En este repo NO existe src/config/env.ts (el bot base si lo
 *    tenia, con Zod). Se leen las variables con process.env, igual que hace
 *    src/core/db/supabase.ts, y se avisa por consola si faltan en vez de
 *    tumbar el arranque: el bot debe poder correr sin pagos configurados.
 *
 * Notas de Bold que valen oro (verificadas en el codigo base original):
 *  - La "Llave de identidad" sirve para la API de Link de pagos (POST /online/link/v1).
 *    No hace falta activar el producto "API Pagos en Linea", que es otra cosa.
 *  - En SANDBOX el webhook NO se dispara automaticamente: hay que activarlo a
 *    mano desde el comprobante de venta simulado ("Probar el webhook") despues
 *    de cada pago de prueba. En produccion si se dispara solo.
 *  - En SANDBOX la firma del webhook se calcula con llave secreta VACIA.
 */

export const CURRENCY = "COP";

const BOLD_BASE_URL = process.env.BOLD_BASE_URL || "https://integrations.api.bold.co";
const BOLD_API_KEY = process.env.BOLD_API_KEY;

export const boldConfigured = Boolean(BOLD_API_KEY);

if (!boldConfigured) {
  console.warn(
    "[bold] Falta BOLD_API_KEY en el .env — no se pueden generar links de pago. " +
      "El Agente de Pagos va a responder que todavia no puede cobrar por este medio."
  );
}

let linksClient: AxiosInstance | null = null;

function getLinksClient(): AxiosInstance {
  if (!boldConfigured) {
    throw new Error("Bold no esta configurado: falta BOLD_API_KEY en el .env");
  }
  if (!linksClient) {
    linksClient = axios.create({
      baseURL: BOLD_BASE_URL,
      timeout: 15_000,
      headers: {
        Authorization: `x-api-key ${BOLD_API_KEY}`,
        "Content-Type": "application/json",
      },
    });
  }
  return linksClient;
}

/** Que parte de la reserva se esta cobrando en este link. */
export type TipoPago = "total" | "abono" | "saldo";

/**
 * Bold soporta dos modalidades de link y NO existe una intermedia:
 *   - CLOSE: monto fijo, el huesped no lo puede cambiar  -> se usa para el TOTAL
 *   - OPEN : el huesped digita el monto en el checkout   -> se usa para el ABONO
 *
 * Por eso, para darle al huesped las dos opciones (pagar todo, o abonar lo que
 * quiera), se generan DOS links y se le mandan los dos en el mismo mensaje. Un
 * solo link "precargado pero editable" no es posible con la API de Bold.
 */
export type ModalidadMonto = "CLOSE" | "OPEN";

/**
 * [2026-09-13] Daniel pidió que el checkout de estos links NO ofrezca "Pago con tarjeta" —
 * esa opción se habilitará más adelante con un link aparte. Se deja "Pago a un clic" tal
 * cual (no se toca), y se restringe solo lo que Bold documenta bajo `payment_methods`.
 *
 * OJO: la doc de Bold para POST /online/link/v1 solo enumera CREDIT_CARD, PSE,
 * BOTON_BANCOLOMBIA y NEQUI — no menciona "QR Bre-B" como valor aparte del campo. Quedó
 * pendiente confirmar en vivo (generando un link real) si Bre-B sigue apareciendo en el
 * checkout al mandar esta lista sin CREDIT_CARD, o si conviene ajustarla.
 */
const PAYMENT_METHODS_SIN_TARJETA = ["PSE", "BOTON_BANCOLOMBIA", "NEQUI"];

export interface CrearLinkDePagoInput {
  /**
   * Monto YA calculado desde la reserva (fn_total_reserva en la base de datos).
   * Este cliente NUNCA calcula precios. En modalidad OPEN se ignora el valor
   * como monto a cobrar, pero se sigue usando para validar que no sea absurdo.
   */
  amountCop: number;
  /** CLOSE = total fijo. OPEN = el huesped digita el abono. Default CLOSE. */
  modalidad?: ModalidadMonto;
  /**
   * Identificador propio que Bold devuelve en data.metadata.reference en el webhook.
   * Formato: `res{id_reserva}-{tipo}-{timestamp}` — incluye la RESERVA (no el
   * contacto) porque un mismo huesped puede tener varias reservas.
   */
  reference: string;
  /** Texto que ve el huesped en el checkout de Bold. */
  description: string;
}

export interface LinkDePago {
  paymentLink: string;
  /** URL de checkout hospedada por Bold — se usa TAL CUAL viene, sin reconstruirla. */
  url: string;
}

/** Crea un link de pago de un solo uso, en COP. */
export async function crearLinkDePago(input: CrearLinkDePagoInput): Promise<LinkDePago> {
  if (!Number.isInteger(input.amountCop) || input.amountCop <= 0) {
    throw new Error(`Monto invalido para el link de pago: ${input.amountCop}`);
  }

  const modalidad: ModalidadMonto = input.modalidad ?? "CLOSE";

  // En OPEN, Bold NO acepta el objeto amount (el monto lo pone el pagador).
  const body =
    modalidad === "OPEN"
      ? {
          amount_type: "OPEN",
          reference: input.reference,
          description: input.description,
          payment_methods: PAYMENT_METHODS_SIN_TARJETA,
        }
      : {
          amount_type: "CLOSE",
          amount: {
            currency: CURRENCY,
            total_amount: input.amountCop,
            tip_amount: 0,
            taxes: [],
          },
          reference: input.reference,
          description: input.description,
          payment_methods: PAYMENT_METHODS_SIN_TARJETA,
        };

  // [2026-09-11] El error de Bold se traduce a mano a proposito. Antes esto era un `await`
  // pelado: si Bold rechazaba la peticion, axios lanzaba un error cuyo `message` es apenas
  // "Request failed with status code 400" — el motivo real viene en `err.response.data` y se
  // perdia. Asi paso el 2026-09-11: un link de $3.000 en modalidad CLOSE fue rechazado, el
  // cliente recibio "dejame confirmar con el equipo" y en el log no habia forma de saber por
  // que. Ahora el motivo de Bold (y el body que le mandamos) quedan en el mensaje del error.
  let res;
  try {
    res = await getLinksClient().post("/online/link/v1", body);
  } catch (err: any) {
    const estado = err?.response?.status;
    const detalle = err?.response?.data;
    throw new Error(
      `Bold rechazo la creacion del link (HTTP ${estado ?? "sin respuesta"}): ` +
        `${detalle ? JSON.stringify(detalle) : err?.message ?? String(err)} | body enviado: ${JSON.stringify(body)}`
    );
  }

  const payload = res.data?.payload;
  if (!payload?.payment_link || !payload?.url) {
    throw new Error(`Bold no devolvio un link de pago valido: ${JSON.stringify(res.data)}`);
  }
  return { paymentLink: payload.payment_link, url: payload.url };
}

/** Estados que puede devolver Bold para un link de pago. */
export type BoldLinkStatus = "ACTIVE" | "PROCESSING" | "PAID" | "REJECTED" | "CANCELLED" | "EXPIRED";

export interface EstadoDelLink {
  status: BoldLinkStatus | string;
  /** Id de la transaccion en Bold — el mismo que llega como payment_id por webhook. */
  transactionId: string | null;
  total: number | null;
  reference: string | null;
}

/**
 * [2026-09-11] Le PREGUNTA a Bold como va un link de pago, en vez de esperar a que Bold nos
 * avise.
 *
 * Por que hace falta teniendo webhook: el webhook es el camino normal, pero depende de que Bold
 * consiga entregarnos la notificacion (y su propia doc admite demoras de hasta 10 minutos en
 * links de pago, ademas de que si las llaves de integracion no estan habilitadas no manda nada).
 * Mientras tanto el cliente ya pago y esta esperando. Con esto, cuando el cliente dice "ya
 * pague", el bot lo verifica de una contra Bold en vez de pedirle el comprobante.
 *
 * Los dos caminos terminan en la MISMA funcion de base (fn_registrar_pago_aprobado), que es
 * idempotente: si el webhook ya lo habia registrado, consultar de nuevo no duplica nada.
 *
 * Devuelve null si no se pudo consultar (red, llave, link inexistente) — quien llama decide que
 * hacer, y nunca se asume "pagado" por un fallo de consulta.
 */
export async function consultarEstadoLink(paymentLink: string): Promise<EstadoDelLink | null> {
  if (!boldConfigured) {
    console.error("[bold] consultarEstadoLink: falta BOLD_API_KEY.");
    return null;
  }
  const id = (paymentLink ?? "").trim();
  if (!id) return null;

  try {
    const res = await getLinksClient().get(`/online/link/v1/${encodeURIComponent(id)}`);
    const p = res.data?.payload ?? res.data;
    if (!p?.status) {
      console.error(`[bold] consultarEstadoLink(${id}): respuesta sin status:`, JSON.stringify(res.data));
      return null;
    }
    return {
      status: String(p.status).toUpperCase(),
      transactionId: p.transaction_id ?? p.transactionId ?? null,
      total: typeof p.total === "number" ? p.total : (p.amount?.total ?? null),
      reference: p.reference ?? null,
    };
  } catch (err: any) {
    const estado = err?.response?.status;
    const detalle = err?.response?.data;
    console.error(
      `[bold] consultarEstadoLink(${id}) fallo (HTTP ${estado ?? "sin respuesta"}): ` +
        `${detalle ? JSON.stringify(detalle) : err?.message ?? String(err)}`
    );
    return null;
  }
}

/**
 * Arma la reference de forma consistente. El webhook la parsea para saber a que
 * reserva y a que tipo de pago corresponde, sin depender de la base de datos.
 */
export function construirReference(idReserva: number | string, tipo: TipoPago): string {
  return `res${idReserva}-${tipo}-${Date.now()}`;
}

export interface LinksDeReserva {
  /** Link de monto fijo por el total pendiente de la reserva. */
  total: LinkDePago & { amountCop: number; reference: string };
  /** Link de monto abierto para que el huesped abone lo que quiera. */
  abono: LinkDePago & { reference: string };
}

/**
 * Genera los DOS links de una reserva: pagar el saldo completo, o abonar.
 * El saldoCop debe venir de fn_saldo_reserva() en la base de datos.
 */
export async function crearLinksDeReserva(
  idReserva: number | string,
  saldoCop: number,
  descripcion: string
): Promise<LinksDeReserva> {
  const refTotal = construirReference(idReserva, "total");
  const refAbono = construirReference(idReserva, "abono");

  const [total, abono] = await Promise.all([
    crearLinkDePago({
      amountCop: saldoCop,
      modalidad: "CLOSE",
      reference: refTotal,
      description: `${descripcion} — pago total`,
    }),
    crearLinkDePago({
      amountCop: saldoCop,
      modalidad: "OPEN",
      reference: refAbono,
      description: `${descripcion} — abono parcial`,
    }),
  ]);

  return {
    total: { ...total, amountCop: saldoCop, reference: refTotal },
    abono: { ...abono, reference: refAbono },
  };
}

export interface ReferenceParseada {
  idReserva: string;
  tipo: TipoPago;
}

/** Lee una reference generada por construirReference. Devuelve null si no matchea. */
export function parsearReference(reference: string): ReferenceParseada | null {
  const m = /^res(\d+)-(total|abono|saldo)-\d+$/.exec(reference);
  if (!m) return null;
  return { idReserva: m[1], tipo: m[2] as TipoPago };
}

// ============================================================================
// Webhook de confirmacion — [2026-09-11]
// ============================================================================
// Adaptado 1:1 del bot base (agente-ycloud-main/src/lib/hash.ts + web/routes/webhooks.bold.ts,
// el bot de "Sebas Raider" del que se partio este proyecto): misma verificacion de firma, mismos
// candidatos de llave en el mismo orden, mismo fallback de reference. Lo unico que cambia es a
// que se llama del lado de la base (aca fn_registrar_pago_aprobado sobre la tabla `pagos`; alla
// era marcarBoldPaymentLinkPagado sobre `bold_payment_links`) porque alla el monto era fijo por
// plan y aca es variable (reserva) — ver server.ts para el uso.

/** Con cual de las llaves configuradas coincidio la firma del webhook. */
export type BoldSecretSource = "webhook_secret" | "api_key" | "secret_key" | "sandbox_vacia";

export type FirmaBoldResultado =
  | { ok: true; fuente: BoldSecretSource }
  | { ok: false; razon: "sin_firma" | "no_coincide" };

/**
 * Bold manda `x-bold-signature: <hex-hmac>`. Lo firmado NO es el body crudo: es el body
 * codificado en Base64, con HMAC-SHA256 (confirmado en developers.bold.co/webhook).
 *
 * QUE llave firma es ambiguo en la doc de Bold — una pagina dice "la llave de identidad", el
 * panel del comercio muestra otro valor junto a la config del webhook, y la cuenta solo expone
 * Llave de identidad + Llave secreta. Por eso, igual que el bot base, se prueban los candidatos
 * mas probables EN ORDEN y se devuelve cual coincidio: el primer webhook real en produccion
 * resuelve la duda mirando los logs, en vez de adivinar a ciegas.
 *
 * En modo SANDBOX, Bold confirma en su doc que la firma se calcula con llave secreta VACIA (no
 * la llave secreta real) — sin ese candidato, un webhook de pruebas real siempre se rechazaria
 * con 401 aunque todo lo demas este bien configurado.
 */
export function verificarFirmaBold(header: string | undefined, rawBody: Buffer | string): FirmaBoldResultado {
  if (!header) return { ok: false, razon: "sin_firma" };

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const bodyBase64 = Buffer.from(bodyStr, "utf8").toString("base64");
  const headerBuf = Buffer.from(header.trim(), "utf8");

  const candidatos: Array<[BoldSecretSource, string]> = [
    ["webhook_secret", process.env.BOLD_WEBHOOK_SECRET ?? ""],
    ["api_key", BOLD_API_KEY ?? ""],
    ["secret_key", process.env.BOLD_SECRET_KEY ?? ""],
    ["sandbox_vacia", ""],
  ];

  for (const [fuente, secret] of candidatos) {
    if (!secret && fuente !== "sandbox_vacia") continue;
    const esperado = Buffer.from(crypto.createHmac("sha256", secret).update(bodyBase64).digest("hex"), "utf8");
    if (esperado.length === headerBuf.length && crypto.timingSafeEqual(esperado, headerBuf)) {
      return { ok: true, fuente };
    }
  }
  return { ok: false, razon: "no_coincide" };
}

/** Forma minima del evento que nos interesa — Bold manda mas campos, no hace falta tiparlos todos. */
export interface BoldWebhookEvent {
  type?: string;
  data?: {
    payment_id?: string;
    order_id?: string;
    orderId?: string;
    metadata?: { reference?: string };
    amount?: { total?: number };
  };
}

/**
 * El `reference` que nosotros mandamos al crear el link (ver construirReference) deberia volver
 * bajo `data.metadata.reference` — es lo que documenta developers.bold.co para "Link de pagos".
 * Se prueban tambien order_id/orderId igual que el bot base, por si Bold los usara en algun caso.
 */
export function extraerReferenceDelEvento(data: BoldWebhookEvent["data"]): string | undefined {
  return data?.metadata?.reference || data?.order_id || data?.orderId;
}
