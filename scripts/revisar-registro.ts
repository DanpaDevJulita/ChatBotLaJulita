/**
 * ¿Por qué no quedaron los datos del cliente y del acompañante en la base?
 *
 *   npx tsx scripts/revisar-registro.ts
 *
 * Mira las tres cosas que pueden haber fallado, en orden, y dice cuál fue:
 *   1. ¿El worker que está corriendo tiene la herramienta? (si no la reiniciaste, no existe)
 *   2. ¿Están cargados los catálogos obligatorios? (sin ellos el insert falla siempre)
 *   3. ¿Qué pasó en la conversación real? (si el bot pidió los datos, si llamó la herramienta)
 *
 * No escribe nada en la base.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { supabase, supabaseConfigured } from "../src/core/db/supabase.js";
import { herramientasDe } from "../src/agentes/_registro.js";

// [2026-09-10] Las herramientas ahora viven en la carpeta de su agente (src/agentes/<bot>/).
const tools = await herramientasDe("ventas");

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const REPORTE = path.join(process.cwd(), `revision-registro-${stamp}.txt`);

function log(...p: unknown[]): void {
  const linea = p.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join(" ");
  console.log(linea);
  fs.appendFileSync(REPORTE, linea + "\n", "utf-8");
}

async function main(): Promise<void> {
  log("REVISIÓN DEL REGISTRO DE CLIENTES Y ACOMPAÑANTES");
  log(`fecha: ${new Date().toISOString()}`);
  log("");

  // ---- 1. La herramienta, en el código ----
  log("=".repeat(88));
  log("== 1. HERRAMIENTAS QUE TIENE EL CÓDIGO");
  log("=".repeat(88));
  const nombres = tools.map((t) => t.name);
  log(`  ${nombres.join(", ")}`);
  if (!nombres.includes("registrar_datos_reserva")) {
    log("  [PROBLEMA] la herramienta registrar_datos_reserva no está registrada en el código");
  } else {
    log("  [OK] registrar_datos_reserva está en el código");
    log("  [OJO] esto NO garantiza que el worker EN EJECUCIÓN la tenga: si no reiniciaste");
    log("        `npm run worker` después de agregarla, el proceso viejo sigue sin conocerla.");
  }

  if (!supabaseConfigured) {
    log("  [PROBLEMA] Supabase no está configurado");
    process.exit(0);
  }

  // ---- 2. Catálogos y tablas destino ----
  log("");
  log("=".repeat(88));
  log("== 2. TABLAS");
  log("=".repeat(88));
  for (const tabla of ["tipo_documento", "estado", "clientes", "acompanantes", "reservas"]) {
    const { count, error } = await supabase.from(tabla).select("*", { count: "exact", head: true });
    log(`  ${tabla.padEnd(16)} ${error ? `ERROR: ${error.message}` : `${count} fila(s)`}`);
  }
  const { count: tipos } = await supabase.from("tipo_documento").select("*", { count: "exact", head: true });
  const { count: estados } = await supabase.from("estado").select("*", { count: "exact", head: true });
  if (!tipos || !estados) {
    log("");
    log("  [PROBLEMA] falta cargar los catálogos: sin `tipo_documento` no se puede guardar NI un");
    log("             cliente, y sin `estado` no se puede crear la reserva. Es el BLOQUE A de");
    log("             sql/reserva-datos-cliente.sql. Mientras falte, el bot toma los datos, el");
    log("             insert falla y al cliente le dice que el equipo sigue con su caso.");
  }

  // ---- 3. Qué pasó en las conversaciones reales ----
  log("");
  log("=".repeat(88));
  log("== 3. ÚLTIMOS MENSAJES DE WHATSAPP (para ver qué hizo el bot)");
  log("=".repeat(88));
  const { data: ultimos, error: errorMsg } = await supabase
    .from("mensajes")
    .select("*")
    .eq("canal", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(40);

  if (errorMsg) {
    log(`  ERROR leyendo mensajes: ${errorMsg.message}`);
  } else {
    const filas = (ultimos ?? []).slice().reverse();
    if (filas.length === 0) log("  (no hay mensajes de WhatsApp guardados)");
    for (const m of filas) {
      const quien = m.role === "user" ? "CLIENTE" : `BOT${m.agent_name ? `/${m.agent_name}` : ""}`;
      const cuando = String(m.created_at ?? "").slice(11, 19);
      log(`  ${cuando} [${m.external_id}] ${quien}: ${String(m.content ?? "").replace(/\n/g, " ⏎ ").slice(0, 220)}`);
    }

    // Pistas automáticas
    const textoBot = filas.filter((m: any) => m.role === "assistant").map((m: any) => m.content ?? "").join("\n");
    log("");
    if (/Ya tengo tus datos anotados/i.test(textoBot)) {
      log("  [DIAGNÓSTICO] El bot SÍ llamó la herramienta y la base RECHAZÓ el insert:");
      log("                ese mensaje ('Ya tengo tus datos anotados... se los paso al equipo')");
      log("                es exactamente el que se manda cuando el guardado falla.");
      log("                => falta correr el BLOQUE A de sql/reserva-datos-cliente.sql");
      log("                   (y revisar el log del worker: dice el motivo exacto).");
    } else if (/quedaron registrados tus datos/i.test(textoBot)) {
      log("  [DIAGNÓSTICO] El bot dijo que los datos quedaron registrados, así que el insert");
      log("                funcionó. Si las tablas están vacías, revisá si estás mirando el");
      log("                proyecto de Supabase correcto.");
    } else if (/nombre completo|tipo de documento|cédula|cedula|documento/i.test(textoBot)) {
      log("  [DIAGNÓSTICO] El bot pidió los datos pero NUNCA llamó la herramienta (no aparece");
      log("                ninguno de sus mensajes de confirmación). Lo más probable: el worker");
      log("                en ejecución no tiene la herramienta porque no se reinició después");
      log("                de agregarla. Cerrá `npm run worker` y volvé a levantarlo.");
    } else {
      log("  [DIAGNÓSTICO] No encuentro en el historial ni la petición de datos ni la");
      log("                confirmación. Revisá si la conversación quedó en otro canal o si el");
      log("                historial no se está guardando.");
    }
  }

  log("");
  log(`Reporte guardado en: ${REPORTE}`);
  process.exit(0);
}

main();
