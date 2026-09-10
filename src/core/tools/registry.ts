import type { ToolDefinition } from "./types.js";
import { consultarPlanesTool, consultarAdicionalesTool } from "./catalogo.js";
// [2026-09-08] Estas siguen sin datos cargados en Supabase (faq, configuracion) — se importan
// comentadas para dejar claro qué falta activar, no por error. Para reactivar una: descomenta
// el import de acá arriba que corresponda, su línea en el arreglo `toolsVentas` de abajo, Y el
// bloque correspondiente en prompts/system.md ("Regla central" y "Reglas gatillo por
// herramienta") — si el prompt sigue mencionando una herramienta que no está en el arreglo, el
// modelo puede intentar llamarla y el bot truena con "Herramienta desconocida".
// import { preguntasFrecuentesTool } from "./preguntasFrecuentes.js";
import { registrarDatosReservaTool } from "./reserva.js";
import { buscarReservaClienteTool } from "./postventa.js";
import { consultarFechasAlternativasTool } from "./disponibilidad.js";
// import { consultarHorariosTool } from "./catalogo.js";

/**
 * [2026-09-10] Cada agente (ver decision.agente del orquestador, prompts/orquestador.md) tiene
 * su propio conjunto de herramientas — mismo patrón que src/tools/registry.ts en
 * agente-ycloud-main, pero ahora con un arreglo por agente en vez de uno solo global. runTurn.ts
 * elige cuál arreglo usar según `decision.agente` (ver CONFIG_POR_AGENTE ahí).
 *
 * `informacion`, `reservas` y `pagos` siguen compartiendo el mismo set y el mismo prompt
 * (prompts/system.md) hasta que se construyan sus agentes propios (ver prompts/agentes/*.md,
 * todavía [PENDIENTE] salvo postventa). `postventa` ya tiene su propio prompt y su propio
 * conjunto: además de las herramientas de venta (para poder ofrecer disponibilidad y registrar
 * una reserva nueva si el cliente no tiene ninguna confirmada), suma `buscar_reserva_cliente`.
 */
export const toolsVentas: ToolDefinition[] = [
  consultarPlanesTool,
  // [2026-09-08] Activada: la auditoría encontró que `adicionales` SÍ tiene datos (15 filas con
  // precio: spa premium/intermedio, turco, coctelería, decoraciones, video recuerdo...) y en el
  // CRM las vendedoras los usan para vender más después de la reserva. Estaba desactivada por
  // un supuesto equivocado.
  consultarAdicionalesTool,
  // [2026-09-10] Fechas cercanas con cupo real (API oficial de LobbyPMS, detalle por día): para
  // no dejar al cliente sin alternativa cuando la fecha que pidió está llena.
  consultarFechasAlternativasTool,
  // [2026-09-08] Registro de los datos de la reserva: cliente en `clientes`, acompañantes en
  // `acompanantes` y la reserva en `reservas` como pendiente de pago. Requiere que estén
  // cargadas `tipo_documento` y `estado` (ver sql/reserva-datos-cliente.sql).
  registrarDatosReservaTool,
  // preguntasFrecuentesTool, // [PENDIENTE] reactivar cuando se cargue la tabla `faq` (hoy: 0 filas)
  // consultarHorariosTool,   // [PENDIENTE] reactivar cuando se cargue `configuracion` (hoy: vacía)
];

export const toolsPostventa: ToolDefinition[] = [
  // [2026-09-10] Siempre primero en la práctica (lo exige el prompt de postventa.md): busca la
  // reserva real en la tabla `reservas`, nunca de memoria — puede haberse hecho fuera del bot.
  buscarReservaClienteTool,
  // Si NO aparece una reserva confirmada, postventa pivotea a venta: consulta cupo real y, si
  // el cliente quiere, registra una reserva nueva — mismas herramientas que usa el Agente de
  // Información/Ventas hoy.
  consultarPlanesTool,
  consultarFechasAlternativasTool,
  consultarAdicionalesTool,
  registrarDatosReservaTool,
];

/** Compat: `tools` = toolsVentas, para scripts/diagnostico.ts y scripts/revisar-registro.ts. */
export const tools: ToolDefinition[] = toolsVentas;

export async function getToolSchemas(toolset: ToolDefinition[] = toolsVentas) {
  return Promise.all(
    toolset.map(async (t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.getParameters ? await t.getParameters().catch(() => t.parameters) : t.parameters,
      },
    }))
  );
}

/** La definición completa de una herramienta (para leer banderas como permitirRedaccion). */
export function getTool(name: string, toolset: ToolDefinition[] = toolsVentas): ToolDefinition | undefined {
  return toolset.find((t) => t.name === name);
}

export function getToolHandler(name: string, toolset: ToolDefinition[] = toolsVentas) {
  const tool = toolset.find((t) => t.name === name);
  if (!tool) throw new Error(`Herramienta desconocida: ${name}`);
  return tool.handler;
}
