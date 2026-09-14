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
import { consultarRecargosTool } from "../ventas/herramientas/recargos.js";
// [2026-09-14] `preguntar_forma_de_pago` es del bot de PAGOS, pero tiene que estar TAMBIÉN acá
// por la misma razón que está en `reservas` (ver ../reservas/agente.ts):
// `registrar_datos_reserva` la encadena con `forzarSiguienteHerramienta`, y el modelo solo puede
// llamar una herramienta que esté en el arreglo del agente que está corriendo AHORA.
//
// Sin esto, el caso que el propio prompt de postventa contempla —el cliente escribe por acá, no
// aparece ninguna reserva suya y el bot "pivotea a venta"— terminaba mal: al registrar la
// reserva, el pipeline forzaba una herramienta que este agente no declara, la llamada al modelo
// fallaba y el cliente recibía "Perdón, no pude procesar eso" en vez del link de pago.
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
    consultarRecargosTool,
    registrarDatosReservaTool,
    // Va junto a `registrarDatosReservaTool` porque es su continuación forzada — ver el
    // comentario del import, arriba.
    preguntarFormaDePagoTool,
    // [2026-09-13] Postventa es justo donde más se pregunta por esto ("¿puedo cambiar la
    // fecha?", "¿me devuelven el dinero?", "¿a qué hora es el check-out?"). El texto sale de la
    // tabla `politicas`, literal — el bot puede CONTAR la política, pero ejecutar el cambio o
    // la cancelación sigue siendo del equipo (ver prompt.md).
    consultarPoliticasTool,
  ],
};
