import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import { buscarFechasAlternativas, type DisponibilidadCategoria } from "../../../core/integrations/lobbypms.js";
import { contarBloqueosActivos } from "../../../core/db/bloqueosRepo.js";
import { fechaCorta } from "../../../core/lib/fechas.js";

/** "DOMO ROMANTIC" -> "Domo Romantic" (los nombres comerciales reales, tal como los usa el equipo). */
function nombreBonito(nombreLobby: string): string {
  return nombreLobby
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/**
 * [2026-09-10] Fechas cercanas con cupo real, para no dejar al cliente sin alternativa cuando la
 * fecha que pidió está llena. Solo la API oficial de LobbyPMS da el detalle por día que hace
 * falta para esto (ver src/core/integrations/lobbypms.ts): si esa vía no está disponible, la
 * herramienta lo dice y el bot vuelve al "le confirmo con el equipo" — nunca inventa fechas.
 *
 * Igual que consultar_planes, le resta los bloqueos temporales que ya tiene tomados OTRA
 * conversación del bot (ver bloqueosRepo.ts), para no ofrecer dos veces el mismo cupo.
 */
export const consultarFechasAlternativasTool: ToolDefinition = {
  name: "consultar_fechas_alternativas",
  permitirRedaccion: true,
  description:
    "Fechas CERCANAS que SÍ tienen cupo, con el tipo de alojamiento que queda libre en cada una. Úsala cuando la fecha que pidió el cliente no tiene cupo (te lo dijo consultar_planes) o cuando el cliente pregunta '¿y qué fechas tienes disponibles?'. Pasale la fecha que pidió el cliente como `fecha` y, si las sabés, `personas` y `noches`. Las FECHAS y los tipos de alojamiento que devuelve se copian EXACTOS: nunca ofrezcas una fecha que no venga en esta respuesta.",
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
        description: "Cuántas personas son. Sirve para no ofrecer un alojamiento donde no caben.",
      },
      dias_alrededor: {
        type: "integer",
        description: "Cuántos días hacia adelante buscar desde `fecha` (7 por defecto, máximo 30).",
      },
    },
    required: ["fecha"],
  },
  handler: async (
    args: { fecha?: string; noches?: number; personas?: number; dias_alrededor?: number },
    ctx: ToolContext
  ) => {
    const fecha = (args?.fecha ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return {
        result: { ok: false, motivo: "fecha inválida" },
        reply_to_user: "¿Me confirmás la fecha que tenés en mente? Con eso te digo qué días tengo disponibles.",
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
          "Justo ahora no puedo confirmarte otras fechas — dejame consultarlo con el equipo de La Julita y te digo enseguida.",
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
      if (libres.length > 0) utiles.push({ fecha: alt.fecha, categorias: libres });
    }

    if (utiles.length === 0) {
      return {
        result: { ok: true, encontradas: 0, desde: fecha, dias_buscados: dias, noches },
        reply_to_user:
          `Busqué los ${dias} días siguientes a esa fecha y no me queda cupo${personas > 0 ? ` para ${personas} personas` : ""}. ` +
          "¿Querés que mire un poco más adelante, o tenés otra fecha en mente?",
      };
    }

    const lineas = utiles
      .map((alt) => `• ${fechaCorta(alt.fecha)}: ${alt.categorias.map((c) => nombreBonito(c.nombreLobby)).join(", ")}`)
      .join("\n");

    const cuantasNoches = noches === 1 ? "1 noche" : `${noches} noches`;
    return {
      result: {
        ok: true,
        encontradas: utiles.length,
        desde: fecha,
        noches,
        dias_buscados: dias,
        fechas: utiles.map((a) => ({
          fecha: a.fecha,
          alojamientos: a.categorias.map((c) => ({ nombre: c.nombreLobby, clase: c.clase, capacidad: c.capacidad })),
        })),
      },
      reply_to_user: `Estas fechas sí tengo libres para ${cuantasNoches}:\n${lineas}\n\n¿Alguna te sirve?`,
    };
  },
};
