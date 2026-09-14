import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
import { consultarPlanesTool, consultarAdicionalesTool } from "./herramientas/planes.js";
import { consultarFechasAlternativasTool } from "./herramientas/disponibilidad.js";
import { registrarDatosReservaTool } from "./herramientas/reserva.js";
import { preguntarFormaDePagoTool, enviarDatosPagoTool, verificarPagoTool } from "./herramientas/pago.js";
import { consultarPoliticasTool } from "./herramientas/politicas.js";
// [2026-09-14] Recargos de niños y mascotas: lo que se cobra APARTE del plan. Antes esos
// valores vivían escritos a mano en la descripción de algunos planes y el bot los borraba
// (no puede mandar una cifra que no pueda verificar) — ver sql/recargos.sql.
import { consultarRecargosTool } from "./herramientas/recargos.js";
// [2026-09-08] Estas dos siguen sin datos cargados en Supabase (faq, configuracion) — se dejan
// importadas en comentario para tener a la vista qué falta activar, no por error. Para
// reactivar una: descomentá el import, su línea en `herramientas` Y el bloque que le
// corresponde en prompt.md — si el prompt menciona una herramienta que no está en el arreglo,
// el modelo puede intentar llamarla y el turno truena con "Herramienta desconocida".
// import { preguntasFrecuentesTool } from "./herramientas/preguntasFrecuentes.js";
// import { consultarHorariosTool } from "./herramientas/planes.js";

/**
 * Agente de VENTAS — el que vende: muestra planes y precios, confirma cupo, ofrece fechas
 * alternativas y toma los datos para dejar la reserva registrada.
 *
 * [2026-09-10] `atiende` tiene tres valores porque hoy este mismo agente cubre los tres temas
 * que el orquestador distingue antes de que exista un bot para cada uno: responder preguntas
 * generales (`informacion`), cotizar/reservar (`reservas`) y el momento de pagar (`pagos`).
 * Los diseños de esos dos bots propios están en src/agentes/reservas/ y src/agentes/pagos/.
 * Cuando alguien construya uno, crea el `agente.ts` de esa carpeta y saca el valor de esta
 * lista — no hace falta tocar ningún otro archivo.
 */
export const agente: DefinicionAgente = {
  nombre: "ventas",
  atiende: ["informacion", "reservas", "pagos"],
  prompt: leerPromptDeAgente("ventas"),
  herramientas: [
    consultarPlanesTool,
    consultarAdicionalesTool,
    consultarRecargosTool,
    consultarFechasAlternativasTool,
    registrarDatosReservaTool,
    // [2026-09-10] Version 1 del modulo de pagos: entrega el link y nada mas. No confirma
    // pagos — eso lo verifica el equipo mirando Bold (ver src/agentes/pagos/LEEME.md).
    //
    // [2026-09-11] Van DOS herramientas y el orden importa: primero se pregunta cómo quiere
    // pagar (abono del 50% o total, con los dos montos) y recién cuando el cliente elige se
    // manda el link, ya con ese valor fijado. El encadenado no depende de que el modelo se
    // acuerde: `registrar_datos_reserva` fuerza `preguntar_forma_de_pago`, y
    // `enviar_datos_pago` sin una modalidad elegida por el cliente devuelve la pregunta en vez
    // de un link.
    preguntarFormaDePagoTool,
    enviarDatosPagoTool,
    // [2026-09-11] "ya pagué": en vez de pedirle el comprobante, el bot le pregunta a Bold.
    verificarPagoTool,
    // [2026-09-13] Reembolsos, cambios de fecha, horarios, jacuzzi, normas: el texto oficial
    // del glamping, tal cual está en la tabla `politicas` (ver sql/politicas.sql).
    consultarPoliticasTool,
    // preguntasFrecuentesTool, // [PENDIENTE] reactivar cuando se cargue la tabla `faq`
    // consultarHorariosTool,   // [PENDIENTE] reactivar cuando se cargue `configuracion`
  ],
};
