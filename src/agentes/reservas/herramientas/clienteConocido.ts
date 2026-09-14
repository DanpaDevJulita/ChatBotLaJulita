import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import { buscarClienteConocidoPorCelular } from "../../../core/db/reservasRepo.js";

/**
 * [2026-09-14] Daniel probando en vivo: "con mi número ya había hecho más reservas, debería
 * recordar información y en vez de volver a pedir datos, preguntar si los datos son correctos, y
 * si no, editar." Antes de esto, `registrar_datos_reserva` no tenía forma de saber si el celular
 * que está escribiendo YA es un cliente guardado — le pedía todo desde cero a cualquiera.
 *
 * Esta herramienta busca por el celular de la conversación (`ctx.externalId`, no lo que diga el
 * cliente — así no hay forma de que alguien "busque" los datos de otro número) y, si encuentra un
 * cliente, le devuelve sus datos para que el bot pueda confirmarlos en vez de repreguntarlos.
 * `permitirRedaccion: true` porque el saludo de "¿otra vez por acá?" debería sonar natural, no a
 * formulario — pero el NOMBRE y el DOCUMENTO que use tienen que salir tal cual de acá (misma regla
 * de siempre: nunca de memoria).
 */
export const consultarClienteConocidoTool: ToolDefinition = {
  name: "consultar_cliente_conocido",
  permitirRedaccion: true,
  description:
    "Busca si el celular de ESTA conversación ya es un cliente conocido (reservó antes). Llámala UNA vez, apenas sepas que el cliente quiere avanzar con una reserva (plan y fecha ya elegidos) y ANTES de pedirle sus datos personales — nunca después de ya haberlos pedido. Si devuelve encontrado=true, NO le pidas los datos de cero: dile con calidez que ya lo tienes registrado y confírmale nombre y documento tal cual salieron de la herramienta, preguntando si siguen siendo correctos o si algo cambió. Si dice que sí, usa esos mismos datos para llamar registrar_datos_reserva (no se los vuelvas a pedir). Si dice que algo cambió, pregunta solo lo que cambió. Si devuelve encontrado=false, es un cliente nuevo: pídele los datos como siempre. Esta herramienta NO busca a los acompañantes — esos se piden siempre de nuevo, porque cambian de viaje a viaje.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async (_args: Record<string, never>, ctx: ToolContext) => {
    const conocido = await buscarClienteConocidoPorCelular(ctx.externalId);

    if (!conocido) {
      return {
        result: { ok: true, encontrado: false },
        reply_to_user: "¡Perfecto! Para dejarlo registrado, ¿me compartes tus datos? 😊",
      };
    }

    return {
      result: {
        ok: true,
        encontrado: true,
        cliente_id: conocido.cliente_id,
        nombre: conocido.nombre,
        tipo_documento: conocido.tipo_documento,
        numero_documento: conocido.numero_documento,
        celular: conocido.celular,
        correo: conocido.correo,
        para_el_modelo:
          "Ya es un cliente conocido. Confírmale nombre y documento EXACTOS de acá arriba y pregúntale si " +
          "siguen siendo correctos, en vez de pedirle todo de cero. Si confirma, usa estos mismos datos al " +
          "llamar registrar_datos_reserva. Los acompañantes SIEMPRE se piden de nuevo (no salen de acá).",
      },
      reply_to_user:
        `¡Qué bueno tenerte de vuelta, ${conocido.nombre.split(/\s+/)[0]}! 💚 Veo que ya tengo tus datos: ` +
        `*${conocido.nombre}*, documento ${conocido.numero_documento}` +
        `${conocido.tipo_documento ? ` (${conocido.tipo_documento})` : ""}. ` +
        "¿Siguen siendo correctos, o cambió algo?",
    };
  },
};
