import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import { recargosRepo, recargoParaEdad, type Recargo } from "../../../core/db/recargosRepo.js";

/**
 * [2026-09-14] "¿Cuánto pagan los niños?" / "¿puedo llevar a mi perro?" — dos de las preguntas más
 * comunes, y hasta hoy el bot no las podía contestar con un número.
 *
 * Esos valores estaban escritos a mano dentro de la descripción de algunos planes (">3 años
 * $50.000"), y como no existían en ninguna columna, el pipeline los borraba antes de mandar el
 * mensaje: una cifra que no se puede verificar contra la base no sale, por diseño. O sea, el
 * cliente se enteraba del recargo por su hijo cuando llegaba al glamping.
 *
 * Con la tabla `recargos` (ver sql/recargos.sql) el dato es real y esta herramienta lo entrega.
 * Si todavía no hay nada cargado para lo que preguntan —hoy es el caso de las mascotas, que el
 * equipo no ha definido— se dice justo eso: que se confirma con el equipo. Ahí sí corresponde,
 * porque el dato de verdad no existe; no es el bot escondiéndose.
 */
function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

/** "1 año" / "4 años" — el plural mal puesto se nota. */
function textoAnios(n: number): string {
  return `${n} ${n === 1 ? "año" : "años"}`;
}

function textoDeRangoDeEdad(r: Recargo): string {
  if (r.edad_min == null && r.edad_max == null) return "";
  if (r.edad_max == null) return ` (de ${r.edad_min} años en adelante)`;
  if (r.edad_min == null) return ` (hasta ${r.edad_max} años)`;
  return ` (de ${r.edad_min} a ${r.edad_max} años)`;
}

function lineaDeRecargo(r: Recargo): string {
  const detalle = (r.descripcion ?? "").trim();
  return `• ${r.nombre}: ${formatMoney(r.precio)}${detalle ? ` — ${detalle}` : ""}`;
}

export const consultarRecargosTool: ToolDefinition = {
  name: "consultar_recargos",
  permitirRedaccion: true,
  description:
    "Lo que se cobra APARTE del plan: niños (por rango de edad) y mascotas. Llámala SIEMPRE que pregunten cuánto paga un niño, si los niños pagan, desde qué edad pagan, o si pueden llevar mascota y cuánto cuesta. Si sabes la edad del niño, pásala en `edad_del_nino` y te devuelve el valor exacto que le corresponde. NUNCA inventes estos valores ni los saques de la descripción de un plan: salen solo de acá.",
  parameters: {
    type: "object",
    properties: {
      tipo: {
        type: "string",
        enum: ["nino", "mascota"],
        description: 'Qué está preguntando el cliente: "nino" para recargos por niños, "mascota" para mascotas. Si pregunta por ambos o no está claro, déjalo vacío y se devuelven todos.',
      },
      edad_del_nino: {
        type: "integer",
        description: "La edad del niño, si el cliente la dijo. Con ella se devuelve el valor exacto que le corresponde a ESE niño.",
      },
    },
    required: [],
  },
  handler: async (args: { tipo?: "nino" | "mascota"; edad_del_nino?: number }, _ctx: ToolContext) => {
    const tipo = args?.tipo === "nino" || args?.tipo === "mascota" ? args.tipo : undefined;
    const recargos = await recargosRepo.list(tipo);

    if (recargos.length === 0) {
      // No hay dato cargado. Acá SÍ corresponde decir que se confirma con el equipo: el valor no
      // existe en ninguna parte, no es que el bot no lo quiera buscar.
      const queFalta = tipo === "mascota" ? "de mascotas" : tipo === "nino" ? "de niños" : "de niños y mascotas";
      console.warn(`[consultar_recargos] no hay recargos ${queFalta} cargados en la tabla \`recargos\`.`);
      return {
        result: { ok: false, motivo: `sin recargos ${queFalta} cargados` },
        reply_to_user:
          `Déjame confirmar ese valor con el equipo de La Julita y te escribo enseguida 🙏`,
      };
    }

    // Si dijeron la edad, se contesta por esa edad puntual: es lo que de verdad preguntaron.
    const edad = Number(args?.edad_del_nino);
    if (Number.isFinite(edad) && edad >= 0) {
      const aplica = recargoParaEdad(recargos, edad);
      if (!aplica) {
        return {
          result: { ok: true, edad, sin_recargo: true },
          reply_to_user: `Un niño de ${textoAnios(edad)} no paga recargo 💚 Entra dentro del plan.`,
        };
      }
      return {
        result: { ok: true, edad, recargo: aplica, valor: aplica.precio },
        reply_to_user:
          `Un niño de ${textoAnios(edad)} paga ${formatMoney(aplica.precio)} adicionales al plan` +
          `${aplica.descripcion ? ` (${aplica.descripcion.trim().replace(/\.$/, "")})` : ""}.`,
      };
    }

    const ninos = recargos.filter((r) => r.tipo === "nino");
    const mascotas = recargos.filter((r) => r.tipo === "mascota");

    const partes: string[] = [];
    if (ninos.length > 0) {
      partes.push(`👦 Niños (valor adicional al plan):\n${ninos.map(lineaDeRecargo).join("\n")}`);
    }
    if (mascotas.length > 0) {
      partes.push(`🐾 Mascotas:\n${mascotas.map(lineaDeRecargo).join("\n")}`);
    }

    return {
      result: recargos.map((r) => ({ ...r, rango: textoDeRangoDeEdad(r).trim() })),
      reply_to_user: partes.join("\n\n"),
    };
  },
};
