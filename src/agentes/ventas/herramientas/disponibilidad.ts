import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import { buscarFechasAlternativas, type DisponibilidadCategoria } from "../../../core/integrations/lobbypms.js";
import { contarBloqueosActivos } from "../../../core/db/bloqueosRepo.js";
import { planesRepo, type Plan } from "../../../core/db/catalogoRepo.js";
import { fechaCorta } from "../../../core/lib/fechas.js";
import {
  cargarCatalogoDomos,
  capacidadDePlan,
  cupoParaPlan,
  esFinDeSemana,
  formatMoney,
  limpiar,
  precioPara,
  segmentoDePlan,
  tarifaDeFecha,
  tipoDePlan,
  type Segmento,
} from "./planes.js";

// [2026-09-18] Acá vivía `nombreBonito`, que dejaba lindos los nombres de las categorías de
// LobbyPMS ("DOMO ROMANTIC" -> "Domo Romantic") para mostrárselos al cliente. Se fue con el
// cambio de esta herramienta: al cliente ya no se le ofrecen domos sueltos, sino planes.

/**
 * [2026-09-10] Fechas cercanas con cupo real, para no dejar al cliente sin alternativa cuando la
 * fecha que pidió está llena. Solo la API oficial de LobbyPMS da el detalle por día que hace
 * falta para esto (ver src/core/integrations/lobbypms.ts): si esa vía no está disponible, la
 * herramienta lo dice y el bot vuelve al "le confirmo con el equipo" — nunca inventa fechas.
 *
 * Igual que consultar_planes, le resta los bloqueos temporales que ya tiene tomados OTRA
 * conversación del bot (ver bloqueosRepo.ts), para no ofrecer dos veces el mismo cupo.
 *
 * [2026-09-18] AHORA OFRECE PLANES, NO DOMOS.
 *
 * Hasta hoy listaba los nombres de las categorías de LobbyPMS ("viernes 18: Domo Deluxe, Domo
 * Familiar"), que es lo que la API devuelve. Daniel lo señaló sobre una conversación real: el
 * cliente no compra un domo, compra un plan — y peor, al leer esa lista preguntó "¿cuál es el
 * domo deluxe?", una pregunta que el bot no sabe contestar porque solo conoce planes. Terminó
 * mandándole el plan de una persona a una pareja.
 *
 * Por eso cada fecha se traduce a los PLANES que le sirven a ese cliente ese día: los que le
 * caben al grupo, que tienen precio para la tarifa de ESE día (un plan sin tarifa de fin de
 * semana no se puede vender un sábado) y cuyo alojamiento quedó libre según LobbyPMS. Una fecha
 * cuyo cupo libre no le sirve a nadie de este grupo ya no se ofrece: mostrarla era invitarlo a
 * elegir algo que después no se le podía vender.
 */
export const consultarFechasAlternativasTool: ToolDefinition = {
  name: "consultar_fechas_alternativas",
  permitirRedaccion: true,
  description:
    "Fechas CERCANAS que SÍ tienen cupo, con los PLANES que se le pueden vender a este cliente en cada una y su precio. Úsala cuando la fecha que pidió el cliente no tiene cupo (te lo dijo consultar_planes) o cuando el cliente pregunta '¿y qué fechas tienes disponibles?'. Pásale la fecha que pidió el cliente como `fecha` y, si los sabes, `personas`, `segmento` y `noches` — sin eso puede ofrecerle planes donde no cabe. Las FECHAS y los NOMBRES DE PLANES que devuelve se copian EXACTOS: nunca ofrezcas una fecha ni un plan que no venga en esta respuesta, y nunca le ofrezcas un tipo de domo suelto (el cliente compra un plan, no un domo).",
  parameters: {
    type: "object",
    properties: {
      fecha: {
        type: "string",
        description: "La fecha desde la cual buscar, en formato AAAA-MM-DD (normalmente la que pidió el cliente).",
      },
      noches: {
        type: "integer",
        description: "Cuántas noches quiere quedarse (1 por defecto). Un pasadía cuenta como 1.",
      },
      personas: {
        type: "integer",
        description: "Cuántas personas son. Sirve para no ofrecer un plan donde no caben.",
      },
      segmento: {
        type: "string",
        enum: ["pareja", "familia", "amigas", "solo", "pasadia"],
        description:
          "El tipo de grupo, si lo sabes: 'pareja', 'familia', 'amigas', 'solo' o 'pasadia'. Con esto los planes que se le ofrecen son los de su grupo.",
      },
      dias_alrededor: {
        type: "integer",
        description: "Cuántos días hacia adelante buscar desde `fecha` (7 por defecto, máximo 30).",
      },
    },
    required: ["fecha"],
  },
  handler: async (
    args: { fecha?: string; noches?: number; personas?: number; segmento?: Segmento; dias_alrededor?: number },
    ctx: ToolContext
  ) => {
    const fecha = (args?.fecha ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return {
        result: { ok: false, motivo: "fecha inválida" },
        reply_to_user: "¿Me confirmas la fecha que tienes en mente? Con eso te digo qué días tengo disponibles.",
      };
    }

    const noches = Math.max(1, Number(args?.noches) || 1);
    const dias = Math.min(30, Math.max(1, Number(args?.dias_alrededor) || 7));
    const personas = Number(args?.personas) || 0;

    const alternativas = await buscarFechasAlternativas(fecha, noches, dias);

    // null = no se pudo consultar la vía que da el detalle por día. No se inventa nada.
    if (!alternativas) {
      return {
        result: { ok: false, motivo: "no se pudo confirmar disponibilidad por día" },
        reply_to_user:
          "Justo ahora no puedo confirmarte otras fechas — déjame consultarlo con el equipo de La Julita y te digo enseguida.",
      };
    }

    // Se descuenta lo que ya está bloqueado por otra conversación del bot.
    const utiles: { fecha: string; categorias: DisponibilidadCategoria[] }[] = [];
    for (const alt of alternativas) {
      const libres: DisponibilidadCategoria[] = [];
      for (const cat of alt.categorias) {
        if (personas > 0 && cat.capacidad < personas) continue;
        const tomados = await contarBloqueosActivos(cat.clase, cat.capacidad, alt.fecha, {
          canal: ctx.channel,
          externalId: ctx.externalId,
        });
        if (cat.disponibles - tomados > 0) libres.push(cat);
      }
      if (libres.length > 0) {
        // [2026-09-17] Si es una persona sola y es fin de semana, no ofrecer
        const esSolo = personas === 1;
        const esFinDeSem = esFinDeSemana(alt.fecha);
        if (esSolo && esFinDeSem) {
          // Saltar este fin de semana para una persona sola
          continue;
        }
        utiles.push({ fecha: alt.fecha, categorias: libres });
      }
    }

    const sinCupo =
      `Busqué los ${dias} días siguientes a esa fecha y no me queda cupo${personas > 0 ? ` para ${personas} personas` : ""}. ` +
      "¿Quieres que mire un poco más adelante, o tienes otra fecha en mente?";

    if (utiles.length === 0) {
      return {
        result: { ok: true, encontradas: 0, desde: fecha, dias_buscados: dias, noches },
        reply_to_user: sinCupo,
      };
    }

    // ---- De categorías de LobbyPMS a PLANES que se le pueden vender a ESTE cliente ----
    const [planes, cat] = await Promise.all([planesRepo.list(true), cargarCatalogoDomos()]);
    const segmento = args?.segmento;

    /** Los planes vendibles en esa fecha, del más barato al más caro. Vacío = esa fecha no sirve. */
    function planesParaLaFecha(f: string, libres: DisponibilidadCategoria[]): { plan: Plan; precio: number }[] {
      const tarifa = tarifaDeFecha(f);
      return planes
        .filter((p) => {
          if (segmento ? segmentoDePlan(p) !== segmento : tipoDePlan(p) === "pasadia") return false;
          // Si busca UNA noche no se le ofrece un plan de dos: el "desde" sería de una estadía
          // más larga que la que pidió, y el cliente compararía peras con manzanas.
          if (noches === 1 && tipoDePlan(p) === "dos_noches") return false;
          const cap = capacidadDePlan(p, cat);
          if (personas > 0 && cap != null && cap < personas) return false;
          // El cupo se mira contra las categorías que quedaron LIBRES ese día (ya descontados
          // los bloqueos de otras conversaciones). `undefined` = no se pudo saber a qué categoría
          // pertenece el plan: se descarta, porque acá el punto es ofrecer solo lo seguro.
          return cupoParaPlan(p, cat, libres) === true;
        })
        .map((p) => ({ plan: p, precio: tarifa ? precioPara(p, tarifa) : null }))
        .filter((x): x is { plan: Plan; precio: number } => x.precio != null)
        .sort((a, b) => a.precio - b.precio);
    }

    const conPlanes = utiles
      .map((alt) => ({ fecha: alt.fecha, opciones: planesParaLaFecha(alt.fecha, alt.categorias) }))
      .filter((x) => x.opciones.length > 0);

    // Puede pasar que haya domos libres pero ningún plan vendible para este grupo (por ejemplo,
    // solo queda un domo de 4 y el cliente viene con 5, o el único plan que aplica no tiene
    // tarifa ese día). Antes eso salía igual como "fecha disponible" y terminaba en una promesa
    // que no se podía cumplir; ahora se trata como lo que es: no hay para ofrecerle.
    if (conPlanes.length === 0) {
      return {
        result: { ok: true, encontradas: 0, desde: fecha, dias_buscados: dias, noches, motivo: "hay cupo pero ningún plan aplica a este grupo" },
        reply_to_user: sinCupo,
      };
    }

    const lineas = conPlanes
      .map(({ fecha: f, opciones }) => {
        const barato = opciones[0];
        // Con una sola opción se dice cuál es; con varias, el "desde" y la invitación a elegir
        // fecha primero — el detalle de los planes sale después con consultar_planes.
        const detalle =
          opciones.length === 1
            ? `${limpiar(barato.plan.nombre)}: ${formatMoney(barato.precio)}`
            : `${opciones.length} planes, desde ${formatMoney(barato.precio)}`;
        return `• ${fechaCorta(f)} — ${detalle}`;
      })
      .join("\n");

    const cuantasNoches = noches === 1 ? "1 noche" : `${noches} noches`;
    return {
      result: {
        ok: true,
        encontradas: conPlanes.length,
        desde: fecha,
        noches,
        dias_buscados: dias,
        fechas: conPlanes.map(({ fecha: f, opciones }) => ({
          fecha: f,
          planes: opciones.map((o) => ({ nombre: o.plan.nombre, precio: o.precio })),
        })),
      },
      reply_to_user:
        `Estas fechas sí tengo libres para ${cuantasNoches}:\n${lineas}\n\n` +
        "¿Cuál te sirve? Te cuento qué incluye 💚",
      // Literal: cada línea casa una fecha con un plan y su precio. Si el modelo la reescribe,
      // basta con que cruce una fecha con el precio de otra para prometerle al cliente algo que
      // no existe (ver ToolResult.forzarTextoLiteral).
      forzarTextoLiteral: true,
    };
  },
};
