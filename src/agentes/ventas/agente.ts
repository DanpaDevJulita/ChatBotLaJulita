import { leerPromptDeAgente, type DefinicionAgente } from "../_tipos.js";
import { consultarPlanesTool, consultarAdicionalesTool } from "./herramientas/planes.js";
// [2026-09-17] Para cuando el cliente pregunta por VARIAS fechas o planes en el mismo mensaje:
// un resumen de una línea por fecha en vez de cotizar todo de golpe (ver herramientas/resumenOpciones.ts).
import { resumirOpcionesTool } from "./herramientas/resumenOpciones.js";
// [2026-09-17] La respuesta a "solo quiero precios": presenta el glamping y pide fecha y
// personas, en vez de tirar tres cifras sueltas (ver herramientas/presentacion.ts).
import { presentarGlampingTool } from "./herramientas/presentacion.js";
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
 * Agente de VENTAS — el que atiende a quien todavía está mirando: preguntas generales del
 * glamping, catálogo de planes con precios y cupo, adicionales, recargos y políticas. Cuando el
 * cliente decide avanzar con un plan y una fecha, el orquestador lo manda a `reservas`, y el
 * cobro lo toma `pagos`.
 *
 * [2026-09-10] Hasta el 2026-09-14 este agente cubría ÉL SOLO los tres temas
 * (`informacion`, `reservas`, `pagos`) porque los otros dos bots no existían todavía.
 *
 * [2026-09-14] Ya existen `src/agentes/reservas/` y `src/agentes/pagos/` con su propio
 * `agente.ts`, así que esos dos temas salieron de acá — es el paso 5 del instructivo de
 * src/agentes/LEEME.md ("si tu bot se queda con un tema que hoy atiende otro, sacá ese tema del
 * `atiende` del otro agente").
 *
 * Por qué importaba corregirlo: mientras los tres temas los declaraban DOS agentes a la vez, el
 * registro (`_registro.ts`) lo detectaba como error de configuración y escupía dos mensajes en
 * cada arranque. Funcionaba de casualidad — gana el primero por orden alfabético, y "pagos" y
 * "reservas" van antes que "ventas" — pero el día que alguien renombrara una carpeta, el ruteo
 * habría cambiado solo, sin que nadie tocara una línea de lógica.
 *
 * Las herramientas de reserva y pago se dejan en la lista a propósito: si un cliente que viene
 * por `informacion` decide avanzar en ese mismo mensaje, este agente puede cerrarle el paso sin
 * cortarle el hilo. Los turnos SIGUIENTES ya se los lleva el bot que corresponde.
 */
export const agente: DefinicionAgente = {
  nombre: "ventas",
  atiende: ["informacion"],
  prompt: leerPromptDeAgente("ventas"),
  herramientas: [
    presentarGlampingTool,
    consultarPlanesTool,
    resumirOpcionesTool,
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
