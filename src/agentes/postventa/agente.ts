import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
import { buscarReservaClienteTool } from "./herramientas/buscarReserva.js";
// Herramientas de otro agente que postventa reutiliza. Viven en la carpeta de su bot dueño
// (ventas) y NO se duplican acá: si se duplicaran, un arreglo de precios habría que hacerlo dos
// veces y es así como se desincronizan los precios entre agentes. Si tocás una de estas,
// avisale a quien lleva postventa.
import { consultarPlanesTool, consultarAdicionalesTool } from "../ventas/herramientas/planes.js";
import { consultarFechasAlternativasTool } from "../ventas/herramientas/disponibilidad.js";
import { registrarDatosReservaTool } from "../ventas/herramientas/reserva.js";

/**
 * Agente de POSTVENTA — atiende a quien ya tiene (o cree tener) una reserva: cambios,
 * cancelaciones, dudas durante la estadía y adicionales.
 *
 * Lo primero que hace siempre es `buscar_reserva_cliente`, porque la única fuente de verdad es
 * la tabla `reservas` de Supabase: una reserva puede haberse hecho fuera del bot (la carga un
 * vendedor en LobbyPMS). Si no encuentra ninguna, pivotea a venta con las herramientas de
 * ventas en vez de dejar al cliente sin salida.
 */
export const agente: DefinicionAgente = {
  nombre: "postventa",
  atiende: ["postventa"],
  prompt: leerPromptDeAgente("postventa"),
  herramientas: [
    buscarReservaClienteTool,
    consultarPlanesTool,
    consultarFechasAlternativasTool,
    consultarAdicionalesTool,
    registrarDatosReservaTool,
  ],
};
