import type { ToolDefinition, ToolResult } from "../../../core/tools/types.js";
import { politica, politicasUnidas } from "../../../core/db/politicasRepo.js";

/**
 * [2026-09-13] Las políticas oficiales del glamping, leídas de la tabla `politicas`
 * (ver sql/politicas.sql y core/db/politicasRepo.ts).
 *
 * VA LITERAL A PROPÓSITO (`permitirRedaccion: false`). Dos razones, y las dos importan:
 *
 *   1. Son condiciones comerciales: plazos ("15 días o más"), montos ($ 100.000, $ 150.000) y
 *      un "sin excepciones" que no admite matices. Si el modelo las redactara con su voz, tarde
 *      o temprano suavizaría un plazo o redondearía un monto, y el cliente tendría en el chat
 *      una promesa que el negocio no va a cumplir.
 *   2. Por cómo funciona la red de seguridad de cifras del pipeline (ver `montosEn` en
 *      core/pipeline/runTurn.ts), una cifra de dinero que el modelo escriba sin que haya salido
 *      de una herramienta hace que se descarte el mensaje entero. Es decir: aunque quisiéramos,
 *      el bot NO podría contar estas políticas de memoria — tiene que llamar esta herramienta.
 *
 * Los montos que devuelve quedan además habilitados para el resto del turno, así que después de
 * llamarla el agente puede referirse a ellos con naturalidad sin que el mensaje se caiga.
 */

const SIN_POLITICA_CARGADA =
  "Déjame confirmar ese detalle con el equipo de La Julita y te escribo enseguida 🙏";

/**
 * [2026-09-18] Las políticas completas (sobre todo tema="estadia" y "todo") pueden pasar los
 * 2.000 caracteres en una sola respuesta — una pared de texto para lo que a veces era una
 * pregunta puntual ("¿a qué hora es el check-in?"). Ver hallazgo de la simulación del
 * 2026-09-15 (F01, D03). El texto SIGUE yendo completo y literal (nada se resume ni se
 * reformula: sigue siendo `permitirRedaccion: false`), solo se reparte en dos burbujas de
 * WhatsApp cuando es largo, cortando en el último salto de línea doble (borde entre secciones:
 * "🕒 *Check-in*", "🛁 *Jacuzzi*", etc. — nunca a mitad de una viñeta o una frase).
 */
const LIMITE_POLITICA_UN_MENSAJE = 900;

function partirPolitica(texto: string, limite = LIMITE_POLITICA_UN_MENSAJE): [string, string] {
  if (texto.length <= limite) return [texto, ""];
  // [2026-09-18 -> 2026-09-18] Bug real encontrado en la re-prueba: el texto que carga el
  // equipo en la tabla `politicas` usa saltos de línea CRLF ("\r\n"), no LF ("\n") — se ve
  // tal cual en la base. La primera versión de esto buscaba solo "\n\n" (LF LF), que un texto
  // en CRLF nunca tiene, así que SIEMPRE caía al corte seco en el límite exacto — y ese corte
  // seco partió la palabra "Fogata" por la mitad ("Fogat" | "a*...") en la prueba del
  // 2026-09-16. La expresión regular de abajo encuentra un salto de línea doble sea cual sea
  // el estilo (\r\n\r\n, \n\n, o mezclado) buscando TODAS las ocurrencias y quedándose con la
  // última que no deje la primera parte demasiado corta.
  const bordes = [...texto.matchAll(/\r?\n\r?\n/g)].map((m) => ({ inicio: m.index!, fin: m.index! + m[0].length }));
  const dentroDelLimite = bordes.filter((b) => b.inicio <= limite);
  const borde =
    dentroDelLimite.length > 0 && dentroDelLimite[dentroDelLimite.length - 1].inicio >= limite * 0.3
      ? dentroDelLimite[dentroDelLimite.length - 1] // el último borde antes del límite, si no queda muy al principio
      : bordes.find((b) => b.inicio > limite); // si no hay uno decente, el próximo borde después del límite
  if (!borde) return [texto, ""]; // sin ningún salto de línea doble reconocible: mejor no partir a ciegas
  return [texto.slice(0, borde.inicio).trimEnd(), texto.slice(borde.fin).trim()];
}

export const consultarPoliticasTool: ToolDefinition = {
  name: "consultar_politicas",
  // El texto sale EXACTO: son condiciones comerciales, no material para redactar.
  permitirRedaccion: false,
  description:
    "Las políticas oficiales de La Julita, en el texto exacto del glamping. Llámala SIEMPRE que el cliente pregunte por reembolsos, cancelaciones, cambios o reprogramación de fecha, qué pasa si no puede venir, si puede ceder su reserva, horarios de check-in/check-out, hora extra, uso del jacuzzi, la fogata, mascotas, parlantes, ruido, menores de edad, si pide los términos y condiciones, o si pregunta si puede PAGAR EN EL SITIO / al llegar / en efectivo allá. Usa tema='reservas' para lo de reembolsos y cambios de fecha, tema='estadia' para horarios, jacuzzi, fogata y normas de convivencia, tema='pago_en_sitio' para pagar en el glamping, y tema='todo' si pide las condiciones completas. NUNCA cuentes estas políticas de memoria ni las reformules: plazos y montos tienen que salir de acá tal cual.",
  parameters: {
    type: "object",
    properties: {
      tema: {
        type: "string",
        enum: ["reservas", "estadia", "pago_en_sitio", "todo"],
        description:
          "'reservas' = términos y condiciones de la reserva (reembolsos, reprogramación, ceder la reserva, cambios de fecha con su valor adicional). 'estadia' = información antes de reservar (check-in/check-out y hora extra, restaurante, jacuzzi, fogata, restricciones y normas de convivencia). 'pago_en_sitio' = si puede pagar en el glamping al llegar y con cuánta anticipación. 'todo' = los términos y la información de la estadía.",
      },
    },
    required: ["tema"],
  },
  handler: async (args: { tema?: string }): Promise<ToolResult> => {
    const temasValidos = ["estadia", "pago_en_sitio", "todo"];
    const tema = temasValidos.includes(args?.tema ?? "") ? (args!.tema as string) : "reservas";

    const texto =
      tema === "estadia"
        ? await politica("antes_de_reservar")
        : tema === "pago_en_sitio"
          ? await politica("pago_en_sitio")
        : tema === "todo"
          ? await politicasUnidas(["terminos_reserva", "antes_de_reservar"], "\n\n")
          : await politica("terminos_reserva");

    // Sin dato en la base no se improvisa: el bot deriva al equipo, igual que hace con los
    // planes cuando la tabla viene vacía. Inventar una condición comercial es peor que demorar
    // la respuesta.
    if (!texto) {
      console.error(
        `[consultar_politicas] No hay política cargada para tema="${tema}". ` +
          "¿Se corrió sql/politicas.sql en Supabase?"
      );
      return {
        result: { ok: false, tema, motivo: "no hay políticas cargadas en la base" },
        reply_to_user: SIN_POLITICA_CARGADA,
      };
    }

    const [primeraParte, resto] = partirPolitica(texto);

    return {
      result: {
        ok: true,
        tema,
        // El texto va también en el `result` para que quede en el historial del modelo: así, si
        // en el mismo turno el cliente repregunta por un detalle, el agente lo tiene a la vista
        // (y sus montos siguen habilitados) sin volver a llamar la herramienta.
        texto,
        nota_para_el_agente:
          "Este texto ya se le mandó al cliente TAL CUAL (en una o dos partes, si era largo). No lo " +
          "repitas ni lo resumas: si hace falta, sigue la conversación con una sola pregunta corta " +
          "(por ejemplo, si le quedó alguna duda).",
      },
      reply_to_user: primeraParte,
      ...(resto ? { textoAdicional: resto } : {}),
    };
  },
};
