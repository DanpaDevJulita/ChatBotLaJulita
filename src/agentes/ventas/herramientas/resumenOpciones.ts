import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import { planesRepo } from "../../../core/db/catalogoRepo.js";
import type { Plan } from "../../../core/db/catalogoRepo.js";
import { consultarDisponibilidad, type DisponibilidadCategoria } from "../../../core/integrations/lobbypms.js";
import { contarBloqueosActivos } from "../../../core/db/bloqueosRepo.js";
import { fechaCorta } from "../../../core/lib/fechas.js";
import {
  cargarCatalogoDomos,
  capacidadDePlan,
  cupoParaPlan,
  formatMoney,
  limpiar,
  precioPara,
  segmentoDePlan,
  tarifaDeFecha,
  tipoDePlan,
  type Segmento,
} from "./planes.js";

/**
 * [2026-09-17] `resumir_opciones` — UNA respuesta corta cuando el cliente pregunta por VARIAS
 * fechas (o varios tipos de plan) en el mismo mensaje.
 *
 * El problema que resuelve, visto en la simulación del 2026-09-15 (escenario D05): el cliente
 * escribió "y para dentro de 15 días cuánto sería? y para el puente que sigue también", y el bot
 * contestó las dos fechas de golpe con el menú completo de cada una — **8 cifras de dinero en un
 * solo mensaje**. Acertó todas las fechas y todos los precios; el problema fue la presentación:
 * el cliente no tiene cómo saber cuál precio va con cuál fecha.
 *
 * La idea la dio Daniel el 2026-09-17: en vez de cotizar todo, un resumen de UNA LÍNEA POR
 * FECHA con el precio "desde", y una pregunta al final para que el cliente elija sobre cuál
 * quiere profundizar. El detalle completo sigue saliendo de `consultar_planes` como siempre,
 * pero recién cuando el cliente dice cuál le interesa.
 *
 * Por qué es una herramienta y no una instrucción del prompt: el "desde $ X" es el precio MÍNIMO
 * entre los planes que aplican a esa fecha, o sea una cuenta. Si la hiciera el modelo, sería una
 * cifra que no salió de ninguna herramienta, y la verificación de runTurn.ts la descartaría — al
 * cliente le llegaría "dame un momento que confirmo con el equipo" en vez del resumen. Además el
 * prompt base le prohíbe expresamente escribir un "desde" que no venga en los datos. Calculándolo
 * acá, el número sale de la base y el mensaje pasa limpio.
 *
 * Va con `permitirRedaccion: false` (texto literal) por la misma razón que el detalle de un plan:
 * es una lista donde cada línea tiene que casar exactamente una fecha con una cifra, y la
 * redacción libre ya causó tres bugs seguidos reordenando ese tipo de contenido (ver
 * ToolResult.forzarTextoLiteral en core/tools/types.ts).
 */

/**
 * Cuántas fechas se listan como máximo. Más que esto ya no es un resumen, es otra pared de texto
 * — que es justo lo que esta herramienta viene a evitar. Lo fijó Daniel el 2026-09-17: "máximo 4
 * fechas listadas y pedimos que priorice". Las que sobran NO se descartan en silencio: el mensaje
 * avisa cuántas quedaron fuera y le pide al cliente que diga cuáles le interesan de verdad.
 */
const MAX_CONSULTAS = 4;

interface Consulta {
  fecha?: string;
  segmento?: Segmento;
  personas?: number;
  festivo?: boolean;
  plan?: string;
}

const ETIQUETA_SEGMENTO: Record<Segmento, string> = {
  pareja: "plan pareja",
  familia: "plan familiar",
  amigas: "plan amigas",
  solo: "plan para una persona",
  pasadia: "pasadía",
};

/**
 * Los planes que aplican a una consulta. Mismo criterio que usa `consultar_planes` para filtrar,
 * pero reducido a lo que necesita un resumen: el segmento (o el nombre del plan, si el cliente
 * nombró uno) y que la tarifa de ESA fecha exista para el plan — un pasadía de domingo no tiene
 * precio de entre semana, y mostrarlo igual sería ofrecerle algo que no puede tomar.
 */
function candidatosDe(planes: Plan[], c: Consulta): Plan[] {
  const buscado = limpiar(c.plan).toLowerCase();
  if (buscado) {
    const porNombre = planes.filter((p) => limpiar(p.nombre).toLowerCase().includes(buscado));
    if (porNombre.length > 0) return porNombre;
  }

  let out = planes;
  if (c.segmento) {
    const delSegmento = out.filter((p) => segmentoDePlan(p) === c.segmento);
    if (delSegmento.length > 0) out = delSegmento;
  }
  // Sin segmento ni plan, un pasadía no debería colarse entre planes de alojamiento: el cliente
  // que pregunta "cuánto sale el 19" está preguntando por una noche.
  if (!c.segmento && !buscado) {
    const soloAlojamiento = out.filter((p) => tipoDePlan(p) !== "pasadia");
    if (soloAlojamiento.length > 0) out = soloAlojamiento;
  }
  return out;
}

interface LineaResumen {
  fecha: string;
  etiqueta: string;
  /** El más barato de los que aplican, con la tarifa de ESA fecha. null si ninguno tiene precio. */
  desde: number | null;
  /** Cuántos planes aplican — con uno solo no se dice "desde", se dice el precio y ya. */
  cuantos: number;
  /** true/false si se pudo confirmar contra LobbyPMS; undefined si no (API caída, o no aplica). */
  cupo: boolean | undefined;
}

function textoDeLinea(l: LineaResumen): string {
  if (l.desde == null) {
    return `📆 ${fechaCorta(l.fecha)} — ${l.etiqueta}: no tengo planes para esa fecha`;
  }
  // "desde" solo cuando de verdad hay de dónde elegir: con un único plan, decir "desde" suena a
  // que hay algo más barato escondido.
  const precio = l.cuantos > 1 ? `desde ${formatMoney(l.desde)}` : formatMoney(l.desde);
  const cupo = l.cupo === true ? " · con cupo ✅" : l.cupo === false ? " · sin cupo esa fecha" : "";
  return `📆 ${fechaCorta(l.fecha)} — ${l.etiqueta}: ${precio}${cupo}`;
}

/**
 * El cierre cambia según lo que se pudo averiguar — es lo que hace que el mensaje sirva en la
 * etapa en la que va la charla, en vez de preguntar siempre lo mismo:
 *  - Si ninguna fecha pudo confirmar cupo, lo que falta es justamente eso, y se ofrece.
 *  - Si TODAS salieron sin cupo, no tiene sentido preguntar cuál le amplío: hay que mover la fecha.
 *  - Si hay al menos una con cupo, el paso siguiente es elegir para avanzar con la cotización.
 */
function cierreDe(lineas: LineaResumen[], fueraDeLista: number): string {
  // Si el cliente tiró más fechas de las que entran, eso manda sobre cualquier otro cierre: no
  // tiene sentido invitarlo a elegir de una lista que no muestra todo lo que preguntó.
  if (fueraDeLista > 0) {
    const cuantas = fueraDeLista === 1 ? "una fecha más" : `${fueraDeLista} fechas más`;
    return (
      `Me preguntaste por ${cuantas} 🙏 Para no llenarte de datos te puse estas primero: ` +
      "¿cuál plan quieres que miremos con detalle? ✨"
    );
  }
  const conPrecio = lineas.filter((l) => l.desde != null);
  if (conPrecio.length === 0) {
    return "¿Quieres que miremos otras fechas? 💚";
  }
  if (conPrecio.every((l) => l.cupo === false)) {
    return "Para esas fechas justo no me queda cupo 🙏 ¿Miramos días cercanos? Te digo cuáles tengo libres.";
  }
  if (conPrecio.every((l) => l.cupo === undefined)) {
    return "¿Quieres que verifique la disponibilidad de alguno? ✨";
  }
  return "¿Sobre cuál quieres que te amplíe la información y seguimos con esa? ✨";
}

export const resumirOpcionesTool: ToolDefinition = {
  name: "resumir_opciones",
  description:
    "Resume en UN mensaje corto varias fechas (o varios tipos de plan) cuando el cliente pregunta " +
    "por más de una en el mismo mensaje: una línea por fecha con el precio 'desde' y si hay cupo, " +
    "y una pregunta para que elija cuál quiere ver en detalle. ÚSALA en vez de llamar " +
    "consultar_planes una vez por fecha: así el cliente no recibe seis u ocho precios sueltos sin " +
    "saber cuál es cuál. Cuando el cliente elija una, ahí sí llama consultar_planes con ESA fecha.",
  permitirRedaccion: false,
  parameters: {
    type: "object",
    properties: {
      consultas: {
        type: "array",
        minItems: 1,
        description:
          "Una entrada por cada fecha (o plan) que el cliente preguntó, en el mismo orden en que " +
          "las mencionó. Si preguntó dos fechas para el mismo tipo de grupo, repite el segmento en " +
          `las dos. Pásalas TODAS aunque sean muchas: se listan las primeras ${MAX_CONSULTAS} y el mensaje ` +
          "le pide al cliente que priorice el resto, en vez de descartarlas en silencio.",
        items: {
          type: "object",
          properties: {
            fecha: {
              type: "string",
              description: "La fecha de esa opción, en formato AAAA-MM-DD.",
            },
            segmento: {
              type: "string",
              enum: ["pareja", "familia", "amigas", "solo", "pasadia"],
              description:
                "El tipo de grupo de ESA consulta: 'pareja', 'familia', 'amigas', 'solo' o 'pasadia'.",
            },
            personas: { type: "integer", description: "Para cuántas personas, si lo dijo." },
            festivo: {
              type: "boolean",
              description: "true solo si el cliente aclaró que ese fin de semana es puente festivo.",
            },
            plan: {
              type: "string",
              description: "Nombre (o parte) de un plan puntual, si el cliente preguntó por uno específico.",
            },
          },
          required: ["fecha"],
        },
      },
      nombre_cliente: {
        type: "string",
        description: "El nombre del cliente, si ya lo dijo en la conversación. Solo para saludarlo.",
      },
    },
    required: ["consultas"],
  },
  handler: async (args: { consultas?: Consulta[]; nombre_cliente?: string }, ctx: ToolContext) => {
    const consultas = (args?.consultas ?? []).filter((c) => c && /^\d{4}-\d{2}-\d{2}$/.test(limpiar(c.fecha)));
    if (consultas.length === 0) {
      return {
        result: { error: "No llegó ninguna fecha válida en formato AAAA-MM-DD." },
        reply_to_user: "¿Me confirmas las fechas que te interesan? Así te digo qué tengo para cada una 😊",
      };
    }

    const planes = await planesRepo.list(true);
    if (planes.length === 0) {
      return {
        result: [],
        reply_to_user: "Todavía no tengo los planes cargados — dale la pregunta al equipo de La Julita.",
      };
    }
    const cat = await cargarCatalogoDomos();

    const fueraDeLista = Math.max(0, consultas.length - MAX_CONSULTAS);

    const lineas: LineaResumen[] = [];
    for (const c of consultas.slice(0, MAX_CONSULTAS)) {
      const fecha = limpiar(c.fecha);
      const tarifa = tarifaDeFecha(fecha, c.festivo);
      const candidatos = candidatosDe(planes, c);

      // Los que SÍ tienen tarifa para ese día. Sin fecha válida no hay tarifa, y ahí se cae al
      // precio de referencia de siempre (el más barato de los tres) para no quedarse mudo.
      const conPrecio = candidatos
        .map((p) => ({ plan: p, precio: tarifa ? precioPara(p, tarifa) : null }))
        .filter((x): x is { plan: Plan; precio: number } => x.precio != null);

      // La disponibilidad se consulta UNA vez por fecha (no por plan) y se le resta lo que otras
      // conversaciones de este mismo bot ya tienen bloqueado — igual que en consultar_planes, si
      // no dos clientes verían cupo para el mismo domo al mismo tiempo.
      let disponibilidad: DisponibilidadCategoria[] | null = await consultarDisponibilidad(fecha, 1);
      if (disponibilidad) {
        for (const d of disponibilidad) {
          const tomados = await contarBloqueosActivos(d.clase, d.capacidad, fecha, {
            canal: ctx.channel,
            externalId: ctx.externalId,
          });
          d.disponibles = Math.max(0, d.disponibles - tomados);
        }
      }

      // El más barato manda el "desde", y el cupo se mira sobre ESE mismo plan: es el que el
      // cliente va a pedir primero, así que es del que hay que poder responder si hay o no.
      const masBarato = conPrecio.sort((a, b) => a.precio - b.precio)[0] ?? null;

      const segmento = c.segmento ?? (masBarato ? segmentoDePlan(masBarato.plan) : undefined);
      const etiqueta = limpiar(c.plan)
        ? limpiar(masBarato?.plan.nombre ?? c.plan)
        : segmento
          ? ETIQUETA_SEGMENTO[segmento]
          : "planes disponibles";

      lineas.push({
        fecha,
        etiqueta,
        desde: masBarato?.precio ?? null,
        cuantos: conPrecio.length,
        cupo: masBarato ? cupoParaPlan(masBarato.plan, cat, disponibilidad) : undefined,
      });
    }

    const saludo = limpiar(args?.nombre_cliente)
      ? `¡Claro que sí, ${limpiar(args.nombre_cliente)}! 💚`
      : "¡Claro que sí! 💚";

    const texto = [
      `${saludo} Para lo que me preguntas tengo esto:`,
      "",
      ...lineas.map(textoDeLinea),
      "",
      cierreDe(lineas, fueraDeLista),
    ].join("\n");

    return {
      // Los datos crudos van igual (aunque el texto se mande literal): así las cifras quedan
      // habilitadas para la verificación de runTurn.ts si un hop posterior las vuelve a mencionar.
      result: {
        opciones: lineas.map((l) => ({
          fecha: l.fecha,
          opcion: l.etiqueta,
          desde: l.desde,
          planes_que_aplican: l.cuantos,
          cupo: l.cupo ?? "no se pudo confirmar",
        })),
        fechas_que_no_entraron: fueraDeLista,
      },
      reply_to_user: texto,
    };
  },
};
