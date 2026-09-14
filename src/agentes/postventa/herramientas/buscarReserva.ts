import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import { buscarReservasConfirmadasPorCelular, type ReservaConfirmada } from "../../../core/db/reservasRepo.js";

function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

function formatFecha(fechaISO: string): string {
  const m = fechaISO.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return fechaISO;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function lineaDeReserva(r: ReservaConfirmada, incluirId = false): string {
  const plan = r.plan_nombre ?? "plan sin nombre registrado";
  const fecha = formatFecha(r.fecha_reservada);
  const personas = `${r.numero_huespedes} ${r.numero_huespedes === 1 ? "persona" : "personas"}`;
  const valor = r.total ?? r.valor_total;
  const valorTexto = valor != null ? `, ${formatMoney(valor)}` : "";
  const prefijo = incluirId ? `#${r.id} — ` : "";
  return `${prefijo}${plan}, ${fecha}, ${personas}${valorTexto}`;
}

/**
 * [2026-09-10] Postventa: SIEMPRE hay que llamar esta herramienta primero, antes de asumir que
 * el cliente tiene (o no tiene) una reserva. La fuente real es la tabla `reservas` — nunca lo
 * que el bot recuerde de mensajes anteriores, porque la reserva puede haberse hecho fuera del
 * bot (el vendedor la registra en LobbyPMS y esa reserva llega igual a esta misma tabla).
 *
 * Usa el número de WhatsApp de la conversación (`ctx.externalId`) para buscar — el cliente
 * nunca tiene que "darte" su número, ya lo tienes.
 */
export const buscarReservaClienteTool: ToolDefinition = {
  name: "buscar_reserva_cliente",
  permitirRedaccion: true,
  description:
    "Busca la(s) reserva(s) CONFIRMADA(S) del cliente que está escribiendo, usando su número de WhatsApp. Llámala siempre primero en cualquier conversación de postventa (cambios, cancelación, dudas durante la estadía, adicionales) — nunca asumas de memoria si el cliente tiene o no una reserva confirmada.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async (_args: unknown, ctx: ToolContext) => {
    const reservas = await buscarReservasConfirmadasPorCelular(ctx.externalId);

    if (reservas.length === 0) {
      return {
        result: { encontradas: 0 },
        reply_to_user:
          "No encuentro ninguna reserva confirmada con este número de WhatsApp. ¿Puede que hayas reservado con otro número, o a nombre de otra persona? Cuéntame y lo reviso; si no, dime para qué fecha te gustaría venir y te cuento la disponibilidad.",
      };
    }

    if (reservas.length === 1) {
      const r = reservas[0];
      const texto = `Tu reserva: ${lineaDeReserva(r)}. ¿En qué te ayudo con ella?`;
      return { result: { encontradas: 1, reservas }, reply_to_user: texto };
    }

    const lineas = reservas.map((r) => `• ${lineaDeReserva(r, true)}`).join("\n");
    const texto = `Encontré varias reservas confirmadas con este número:\n${lineas}\n\n¿Cuál de estas es?`;
    return { result: { encontradas: reservas.length, reservas }, reply_to_user: texto };
  },
};
