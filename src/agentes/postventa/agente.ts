import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
import { buscarReservaClienteTool } from "./herramientas/buscarReserva.js";
// Herramientas de otro agente que postventa reutiliza. Viven en la carpeta de su bot dueño
// (ventas) y NO se duplican acá: si se duplicaran, un arreglo de precios habría que hacerlo dos
// veces y es así como se desincronizan los precios entre agentes. Si tocás una de estas,
// avisale a quien lleva postventa.
import { consultarPlanesTool, consultarAdicionalesTool } from "../ventas/herramientas/planes.js";
import { consultarFechasAlternativasTool } from "../ventas/herramientas/disponibilidad.js";
import { registrarDatosReservaTool } from "../ventas/herramientas/reserva.js";
import { consultarPoliticasTool } from "../ventas/herramientas/politicas.js";
// [2026-09-14] Igual que en src/agentes/reservas/agente.ts: cuando alguien sin reserva escribe
// para reservar una fecha nueva (ver más abajo, "Si NO aparece ninguna reserva confirmada"),
// `registrar_datos_reserva` fuerza `preguntar_forma_de_pago` en el mismo turno
// (forzarSiguienteHerramienta) — y esa herramienta tiene que estar en el arreglo del agente que
// está corriendo (postventa) para que el modelo pueda llamarla. Es de PAGOS (`agenteDueno`, ver
// core/tools/types.ts): apenas corre, la conversación queda "pegada" a pagos para el siguiente
// mensaje del cliente.
import { preguntarFormaDePagoTool } from "../ventas/herramientas/pago.js";

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
    preguntarFormaDePagoTool,
    // [2026-09-13] Postventa es justo donde más se pregunta por esto ("¿puedo cambiar la
    // fecha?", "¿me devuelven el dinero?", "¿a qué hora es el check-out?"). El texto sale de la
    // tabla `politicas`, literal — el bot puede CONTAR la política, pero ejecutar el cambio o
    // la cancelación sigue siendo del equipo (ver prompt.md).
    consultarPoliticasTool,
  ],
};
