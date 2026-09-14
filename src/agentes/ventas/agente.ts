import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
import { consultarPlanesTool, consultarAdicionalesTool } from "./herramientas/planes.js";
import { consultarFechasAlternativasTool } from "./herramientas/disponibilidad.js";
import { consultarPoliticasTool } from "./herramientas/politicas.js";
// [2026-09-08] Estas dos siguen sin datos cargados en Supabase (faq, configuracion) — se dejan
// importadas en comentario para tener a la vista qué falta activar, no por error. Para
// reactivar una: descomentá el import, su línea en `herramientas` Y el bloque que le
// corresponde en prompt.md — si el prompt menciona una herramienta que no está en el arreglo,
// el modelo puede intentar llamarla y el turno truena con "Herramienta desconocida".
// import { preguntasFrecuentesTool } from "./herramientas/preguntasFrecuentes.js";
// import { consultarHorariosTool } from "./herramientas/planes.js";

/**
 * Agente de VENTAS — responde preguntas generales y cotiza: muestra planes, precios y
 * adicionales. Ya NO se encarga de tomar los datos de una reserva ni de nada de pagos — eso es
 * de los bots de RESERVAS y PAGOS (ver src/agentes/reservas/ y src/agentes/pagos/).
 *
 * [2026-09-14] Hasta hoy este mismo agente cubría también "reservas" y "pagos" (ver
 * `atiende` antes de este cambio) porque esos dos bots todavía no existían. Ahora que existen,
 * `ventas` queda enfocado solo en su tarea: cotizar y responder preguntas del tema `informacion`.
 * Sigue siendo el bot que registra el registro (ver _registro.ts, AGENTE_POR_DEFECTO), así que
 * cualquier tema sin bot propio sigue cayendo acá — por eso NO se le sacaron
 * `consultar_fechas_alternativas` ni `consultar_politicas`, que siguen sirviendo para el tema
 * `informacion` (alguien mirando opciones, sin haber elegido fecha todavía).
 */
export const agente: DefinicionAgente = {
  nombre: "ventas",
  atiende: ["informacion"],
  prompt: leerPromptDeAgente("ventas"),
  herramientas: [
    consultarPlanesTool,
    consultarAdicionalesTool,
    consultarFechasAlternativasTool,
    // [2026-09-13] Reembolsos, cambios de fecha, horarios, jacuzzi, normas: el texto oficial
    // del glamping, tal cual está en la tabla `politicas` (ver sql/politicas.sql).
    consultarPoliticasTool,
    // preguntasFrecuentesTool, // [PENDIENTE] reactivar cuando se cargue la tabla `faq`
    // consultarHorariosTool,   // [PENDIENTE] reactivar cuando se cargue `configuracion`
  ],
};
