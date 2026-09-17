/**
 * [2026-09-17] Migra las descripciones de `planes` al token `$$$$`.
 *
 *   npx tsx scripts/migrar-precios-a-token.ts            # vista previa, no escribe nada
 *   npx tsx scripts/migrar-precios-a-token.ts --aplicar  # escribe (deja respaldo antes)
 *
 * Por qué: el precio de un plan está escrito DOS veces — en las columnas
 * precio_entre_semana / precio_fin_de_semana / precio_fin_de_semana_puente (la fuente real, la
 * que el equipo edita desde el panel) y, a mano, adentro del texto libre de `descripcion`. Al
 * cambiar la columna, el texto queda viejo y el cliente ve dos precios distintos para el mismo
 * plan en el mismo mensaje.
 *
 * La regla, decidida por Daniel el 2026-09-17: en la descripción, donde iba el número va el
 * texto literal `$$$$`. El bot lo reemplaza por el precio de la columna que corresponda según
 * lo que diga esa misma línea ("entre semana", "fin de semana", "puente/festivo") — ver
 * resolverPreciosEnDescripcion en src/agentes/ventas/herramientas/planes.ts.
 *
 * Dos excepciones, también decididas por Daniel:
 *  - Los precios del Domo Deluxe metidos en la descripción del PLAN UNA PERSONA (id 28) se
 *    BORRAN: el deluxe ya es su propio plan (id 29) con sus propias columnas. Ponerles `$$$$`
 *    los resolvería con el precio del clásico, o sea un precio equivocado al cliente.
 *  - Los recargos de niños de los planes familiares (ids 30 y 31) se BORRAN: ya viven en la
 *    tabla `recargos`, que el bot consulta con `consultar_recargos`.
 *
 * Lo que NO se toca: montos que no son el precio de un plan ni están duplicados en ninguna otra
 * tabla (ej. "bebidas de hasta $10.000" del id 3). Son parte del texto que el equipo escribió a
 * propósito y el bot los muestra tal cual.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { supabase, supabaseConfigured } from "../src/core/db/supabase.js";

const APLICAR = process.argv.includes("--aplicar");

/** Un monto de dinero escrito en el texto: "$339.000", "$ 1.090.000". */
const MONTO = /\$\s?\d[\d.,]*\d/g;

/** Líneas que se BORRAN enteras, por plan (ver el encabezado del archivo). */
const BORRAR: Record<number, RegExp[]> = {
  28: [/deluxe/i],
  30: [/^\s*>\s*\d+\s*años/i],
  31: [/^\s*>\s*\d+\s*años/i],
};

/** Planes a migrar. El id 3 queda afuera a propósito: su único monto no es precio de plan. */
const IDS = [28, 30, 31, 32];

function migrarDescripcion(id: number, texto: string): string {
  const borrar = BORRAR[id] ?? [];
  return texto
    .split("\n")
    .filter((linea) => !(MONTO.test(linea) && ((MONTO.lastIndex = 0), borrar.some((re) => re.test(linea)))))
    .map((linea) => linea.replace(MONTO, "$$$$$$$$")) // "$$$$" literal: $$ en replace() es un $
    .join("\n");
}

if (!supabaseConfigured) {
  console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el .env.");
  process.exit(1);
}

const { data, error } = await supabase.from("planes").select("id,nombre,descripcion").in("id", IDS).order("id");
if (error) {
  console.error("No pude leer `planes`:", error);
  process.exit(1);
}

const cambios: { id: number; nombre: string; antes: string; despues: string }[] = [];

for (const p of data ?? []) {
  const antes = p.descripcion ?? "";
  const despues = migrarDescripcion(p.id, antes);
  if (antes === despues) continue;
  cambios.push({ id: p.id, nombre: p.nombre, antes, despues });

  // Comparar línea por línea con un diff de verdad es más código del que vale para 4 planes:
  // alcanza con listar lo que desaparece y mostrar el texto final completo, que es lo que de
  // verdad hay que revisar antes de escribir en la base.
  const quedaron = new Set(despues.split("\n").map((l) => l.trim()));
  console.log(`\n${"=".repeat(78)}\nid=${p.id} | ${p.nombre}`);
  console.log("  --- líneas que desaparecen ---");
  for (const linea of antes.split("\n")) {
    const t = linea.trim();
    if (t && !quedaron.has(t)) console.log(`  - ${t}`);
  }
  console.log("  --- descripción resultante ---");
  console.log(despues.split("\n").map((l) => `  | ${l}`).join("\n"));
}

if (cambios.length === 0) {
  console.log("\nNada que migrar: las descripciones ya están en `$$$$`.");
  process.exit(0);
}

if (!APLICAR) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`VISTA PREVIA — ${cambios.length} plan(es) cambiarían. No se escribió nada.`);
  console.log("Para aplicar:  npx tsx scripts/migrar-precios-a-token.ts --aplicar");
  process.exit(0);
}

// Respaldo antes de escribir: el texto original completo, por si hay que volver atrás.
const respaldo = path.join(process.cwd(), "_respaldos", `planes-descripcion-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(respaldo), { recursive: true });
fs.writeFileSync(respaldo, JSON.stringify(cambios.map(({ id, nombre, antes }) => ({ id, nombre, descripcion: antes })), null, 2), "utf-8");
console.log(`\nRespaldo escrito en ${respaldo}`);

for (const c of cambios) {
  const { error: errUpd } = await supabase.from("planes").update({ descripcion: c.despues }).eq("id", c.id);
  if (errUpd) console.error(`  id=${c.id}: FALLÓ —`, errUpd.message);
  else console.log(`  id=${c.id} "${c.nombre}": actualizado.`);
}
console.log("\nListo.");
