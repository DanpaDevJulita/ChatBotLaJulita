// FILE: src/core/pipeline/comandos.ts
// MODIFICATIONS for "corrige" prefix detection and ticket creation

import { abrirTicketReportado, abrirTicketEnsenanza } from "../db/ticketsRepo.js";
import { permisosDeNumero } from "../db/usuariosPanelRepo.js";

// ============================================================
// ADD THESE IMPORTS at the top of the file
// ============================================================
// import { abrirTicketReportado, abrirTicketEnsenanza } from "../db/ticketsRepo.js";
// import { permisosDeNumero } from "../db/usuariosPanelRepo.js";

// ============================================================
// ADD THESE CONSTANTS
// ============================================================

/**
 * Regex to detect "corrige" variants with optional punctuation/slash.
 * Accepts: "corrige", "Corrige,", "/corrige:", "corrija", "corrígeme", "corrigeme"
 */
export const PREFIJO_REPORTE = /^[\s"'""¡!¿?.,;:\-–—]*\/?\s*(corrige|corrija|corregir|corrígeme|corrigeme)\b[\s"'"".,;:\-–—]*/i;

// ============================================================
// ADD THESE HELPER FUNCTIONS
// ============================================================

/**
 * Extracts the fault description text after the "corrige" prefix.
 * Returns the remaining text after prefix, or null if no match.
 */
export function extraerReporteDeFalla(texto: string): string | null {
  const match = texto.match(PREFIJO_REPORTE);
  if (!match) return null;

  const prefixLength = match[0].length;
  const textoRestante = texto.substring(prefixLength).trim();

  return textoRestante || null;
}

/**
 * Checks if a phone number is authorized to report faults.
 * First checks the panel's users table via permisosDeNumero.
 * Falls back to .env REPORTE_FALLAS_NUMBERS if database lookup fails.
 */
export async function puedeReportarFalla(externalId: string): Promise<boolean> {
  try {
    // First: check users table
    const permisos = await permisosDeNumero(externalId);
    if (permisos !== null) {
      // Database lookup succeeded
      return permisos.puedeReportar;
    }

    // Second: fall back to .env
    const envNumbers = (process.env.REPORTE_FALLAS_NUMBERS || "").split(",");
    const clave = externalId.replace(/\D/g, "").slice(-10);

    return envNumbers.some((num) => {
      const numClave = num.trim().replace(/\D/g, "").slice(-10);
      return numClave === clave;
    });
  } catch (err) {
    console.error("Error checking fault report authorization:", err);
    // Fall back to .env on unexpected errors
    const envNumbers = (process.env.REPORTE_FALLAS_NUMBERS || "").split(",");
    const clave = externalId.replace(/\D/g, "").slice(-10);
    return envNumbers.some((num) => {
      const numClave = num.trim().replace(/\D/g, "").slice(-10);
      return numClave === clave;
    });
  }
}

// ============================================================
// MODIFY EXISTING FUNCTION: intentarComando
// ============================================================

/**
 * CHANGE SIGNATURE from:
 *   async function intentarComando(texto: string, ...)
 *
 * TO:
 *   async function intentarComando(texto: string, medio: "texto" | "audio", ...)
 *
 * This parameter tells us if the input came from text or audio.
 */

// ============================================================
// ADD HOOK: Before slash command detection
// ============================================================

/**
 * ADD THIS CODE at the beginning of intentarComando(), BEFORE any slash command checks:
 *
 * // Detect "corrige" prefix for fault reports
 * if (PREFIJO_REPORTE.test(texto)) {
 *   const reporte = extraerReporteDeFalla(texto);
 *   if (reporte && (await puedeReportarFalla(externalId))) {
 *     // User is authorized: create fault ticket
 *     const resultado = await abrirTicketReportado(
 *       reporte,
 *       externalId,
 *       "whatsapp", // or detect based on context
 *       externalId,
 *       medio // "texto" or "audio"
 *     );
 *
 *     if (resultado.id) {
 *       console.log(`Fault ticket #${resultado.id} created`);
 *       // Optionally send acknowledgment to user
 *       await ctx.send(`✅ Tu reporte de falla ha sido registrado (ticket #${resultado.id}). El equipo lo revisará en breve.`);
 *       return; // Stop processing, command is handled
 *     } else {
 *       console.error("Failed to create fault ticket:", resultado.error);
 *       await ctx.send(`❌ Hubo un error al registrar tu reporte. Por favor intenta de nuevo.`);
 *       return;
 *     }
 *   }
 * }
 *
 * // Then continue with slash command detection (/corrige, /aprende, etc.)
 */

// ============================================================
// MODIFY: /aprende command handler
// ============================================================

/**
 * CHANGE the /aprende handler to ALSO create a teaching ticket:
 *
 * ADD AFTER the correction rule is saved:
 *   // Create audit trail: ticket for teaching history
 *   const guardada = ... // existing code that saves the correction
 *
 *   if (guardada.id) {
 *     const ticketResult = await abrirTicketEnsenanza(
 *       `Regla: ${guardada.patrón} → ${guardada.respuesta}`,
 *       externalId,
 *       guardada.id ?? 0, // correccionId
 *       "whatsapp"
 *     );
 *
 *     if (ticketResult.id) {
 *       console.log(`Teaching ticket #${ticketResult.id} created for correction #${guardada.id}`);
 *     } else {
 *       console.error("Failed to create teaching ticket:", ticketResult.error);
 *     }
 *   }
 */
