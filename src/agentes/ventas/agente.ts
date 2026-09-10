import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
import { consultarPlanesTool, consultarAdicionalesTool } from "./herramientas/planes.js";
import { consultarFechasAlternativasTool } from "./herramientas/disponibilidad.js";
import { registrarDatosReservaTool } from "./herramientas/reserva.js";
<<<<<<< HEAD
=======
import { enviarDatosPagoTool } from "./herramientas/pago.js";
>>>>>>> origin/BotDevelopment
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
    consultarFechasAlternativasTool,
    registrarDatosReservaTool,
<<<<<<< HEAD
=======
    // [2026-09-10] Version 1 del modulo de pagos: entrega el link y nada mas. No confirma
    // pagos — eso lo verifica el equipo mirando Bold (ver src/agentes/pagos/LEEME.md).
    enviarDatosPagoTool,
>>>>>>> origin/BotDevelopment
    // preguntasFrecuentesTool, // [PENDIENTE] reactivar cuando se cargue la tabla `faq`
    // consultarHorariosTool,   // [PENDIENTE] reactivar cuando se cargue `configuracion`
  ],
};
