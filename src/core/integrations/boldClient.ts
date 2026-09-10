import axios, { AxiosInstance } from "axios";

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
        };

  const res = await getLinksClient().post("/online/link/v1", body);
  const payload = res.data?.payload;
  if (!payload?.payment_link || !payload?.url) {
    throw new Error(`Bold no devolvio un link de pago valido: ${JSON.stringify(res.data)}`);
  }
  return { paymentLink: payload.payment_link, url: payload.url };
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

export type BoldLinkStatus = "ACTIVE" | "PROCESSING" | "PAID" | "REJECTED" | "CANCELLED" | "EXPIRED";

/** Consulta el estado de un link — respaldo por si el webhook no llega (polling manual). */
export async function consultarEstadoLink(paymentLink: string): Promise<BoldLinkStatus | null> {
  const res = await getLinksClient().get(`/online/link/v1/${encodeURIComponent(paymentLink)}`);
  return (res.data?.status as BoldLinkStatus) ?? null;
}
