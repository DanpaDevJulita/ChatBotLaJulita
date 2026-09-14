import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
// Las tres herramientas de pago viven en ventas/herramientas/pago.ts (mismo archivo que las creó
// en la versión 1 del módulo, ver LEEME.md de esta carpeta) — pagos las importa, no las duplica,
// misma convención de siempre ("herramienta compartida, vive en la carpeta de su dueño real").
import { preguntarFormaDePagoTool, enviarDatosPagoTool, verificarPagoTool } from "../ventas/herramientas/pago.js";

/**
 * Agente de PAGOS — todo lo relacionado con cobrar una reserva ya registrada: preguntar cómo va
 * a pagar (abono del 50% o total), mandar el link con el monto ya fijado, y verificar contra Bold
 * cuando el cliente dice que ya pagó.
 *
 * [2026-09-14] Antes esto lo cubría `ventas` (ver la nota vieja en ventas/agente.ts). Se separa
 * ahora para que el bot de pagos se enfoque solo en cobrar y lo haga bien — reservas ya dejó el
 * cupo apartado, y en cuanto el pago se confirma (`verificar_pago`, o los chequeos automáticos de
 * `bloqueoQueue.ts`), la reserva queda confirmada y postventa toma la posta.
 *
 * `preguntar_forma_de_pago` está marcada como dueña de `pagos` (`agenteDueno`, ver
 * core/tools/types.ts) aunque a veces la llame `reservas` o `postventa` en el mismo turno que
 * registran la reserva — eso es lo que hace que, apenas corre, la conversación quede "pegada" acá
 * para el mensaje siguiente del cliente ("abono", "total"), en vez de quedarse en un bot que ya
 * no tiene las herramientas para seguir.
 */
export const agente: DefinicionAgente = {
  nombre: "pagos",
  atiende: ["pagos"],
  prompt: leerPromptDeAgente("pagos"),
  herramientas: [preguntarFormaDePagoTool, enviarDatosPagoTool, verificarPagoTool],
};
