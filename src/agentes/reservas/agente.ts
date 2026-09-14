import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
// Herramientas de otros bots que reservas reutiliza. Viven en la carpeta de su bot dueño y NO se
// duplican acá — misma convención que ya usa postventa (ver src/agentes/postventa/agente.ts).
import { consultarPlanesTool } from "../ventas/herramientas/planes.js";
import { consultarFechasAlternativasTool } from "../ventas/herramientas/disponibilidad.js";
import { registrarDatosReservaTool } from "../ventas/herramientas/reserva.js";
import { consultarPoliticasTool } from "../ventas/herramientas/politicas.js";
// [2026-09-14] `preguntar_forma_de_pago` es del bot de PAGOS (ver ../pagos/agente.ts y el
// comentario de `agenteDueno` en core/tools/types.ts) pero tiene que estar TAMBIÉN acá: cuando
// `registrar_datos_reserva` la fuerza en el mismo turno (forzarSiguienteHerramienta), el modelo
// solo puede llamar una herramienta que esté en el arreglo del agente que está corriendo AHORA
// (reservas) — ver la restricción en runTurn.ts. El campo `agenteDueno` de la herramienta se
// encarga de que, apenas corre, la conversación quede "pegada" a pagos para el mensaje siguiente.
import { preguntarFormaDePagoTool } from "../ventas/herramientas/pago.js";
// [2026-09-15] Esta sí es propia de reservas (no de ventas): reconocer a un cliente que ya
// reservó antes, para no pedirle los datos de cero. Ver herramientas/clienteConocido.ts.
import { consultarClienteConocidoTool } from "./herramientas/clienteConocido.js";

/**
 * Agente de RESERVAS — el que concreta la venta: toma la fecha, el plan y los datos de cada
 * huésped, deja el cupo apartado (bloqueo temporal + LobbyPMS) y entrega la reserva registrada.
 * De ahí en más, el pago lo atiende el bot de PAGOS (ver ../pagos/agente.ts) — reservas solo
 * pregunta cómo va a pagar (abono o total) porque ese primer paso tiene que salir en el MISMO
 * turno que registra los datos, sin depender de un mensaje extra del cliente.
 *
 * [2026-09-14] Antes de que existiera este bot, `ventas` cubría a la vez "informacion",
 * "reservas" y "pagos" (ver la nota vieja en ventas/agente.ts). Se separa ahora para que cada bot
 * se enfoque en su tarea: ventas solo cotiza y responde preguntas generales, reservas solo se
 * encarga de concretar el cupo, y pagos solo del cobro.
 */
export const agente: DefinicionAgente = {
  nombre: "reservas",
  atiende: ["reservas"],
  prompt: leerPromptDeAgente("reservas"),
  herramientas: [
    consultarPlanesTool,
    consultarFechasAlternativasTool,
    consultarClienteConocidoTool,
    registrarDatosReservaTool,
    preguntarFormaDePagoTool,
    // Para cuando, a mitad de dar los datos, el cliente pregunta "¿y si cancelo?" o "¿puedo
    // cambiar la fecha después?" — el texto oficial, nunca de memoria.
    consultarPoliticasTool,
  ],
};
