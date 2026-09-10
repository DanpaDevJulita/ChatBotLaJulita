/**
 * Verifica el registro de agentes — creado el 2026-09-10.
 *
 * Corre contra los agentes REALES de src/agentes/: confirma que cada carpeta se descubre bien,
 * que su prompt existe, que sus herramientas están sanas y que todos los temas que enruta el
 * orquestador tienen quién los atienda.
 *
 *   npx tsx scripts/probar-agentes.ts
 *
 * Corré esto después de crear un bot nuevo o de cambiar el campo `atiende` de uno.
 */
import "dotenv/config";
import { cargarAgentes, agenteQueAtiende } from "../src/agentes/_registro.js";

/** Los valores que puede devolver el orquestador (ver src/agentes/orquestador/prompt.md).
 *  "humano" no está: lo corta el pipeline antes de llegar a un agente. */
const TEMAS_DEL_ORQUESTADOR = ["informacion", "reservas", "pagos", "postventa"];

let problemas = 0;
function ok(texto: string): void {
  console.log(`  [ok]   ${texto}`);
}
function falla(texto: string): void {
  console.log(` [FALLA] ${texto}`);
  problemas++;
}

console.log("VERIFICACIÓN DEL REGISTRO DE AGENTES");
console.log("");

const agentes = await cargarAgentes();

if (agentes.length === 0) {
  falla("no se descubrió ningún agente en src/agentes/ — ¿falta el archivo agente.ts de alguna carpeta?");
} else {
  ok(`${agentes.length} agente(s) descubierto(s): ${agentes.map((a) => a.nombre).join(", ")}`);
}

console.log("");
for (const a of agentes) {
  console.log(`--- ${a.nombre} ---`);
  console.log(`  atiende: ${a.atiende.join(", ")}`);
  console.log(`  herramientas: ${a.herramientas.map((h) => h.name).join(", ") || "(ninguna)"}`);

  if (!a.prompt || a.prompt.trim().length < 50) {
    falla(`${a.nombre}: el prompt está vacío o es sospechosamente corto (${a.prompt?.length ?? 0} caracteres)`);
  } else {
    ok(`${a.nombre}: prompt cargado (${a.prompt.length} caracteres)`);
  }

  if (a.herramientas.length === 0) {
    falla(`${a.nombre}: no tiene ninguna herramienta`);
  }

  const nombres = a.herramientas.map((h) => h.name);
  const repetidas = nombres.filter((n, i) => nombres.indexOf(n) !== i);
  if (repetidas.length > 0) {
    falla(`${a.nombre}: tiene herramientas repetidas (${[...new Set(repetidas)].join(", ")})`);
  }

  const sinDescripcion = a.herramientas.filter((h) => !h.description || h.description.length < 20);
  if (sinDescripcion.length > 0) {
    falla(
      `${a.nombre}: estas herramientas no tienen una descripción usable, y es lo único que el ` +
        `modelo lee para decidir cuándo llamarlas: ${sinDescripcion.map((h) => h.name).join(", ")}`
    );
  }
  console.log("");
}

console.log("--- ¿todos los temas del orquestador tienen agente? ---");
for (const tema of TEMAS_DEL_ORQUESTADOR) {
  const a = await agenteQueAtiende(tema);
  const propio = a?.atiende.includes(tema);
  if (!a) {
    falla(`"${tema}": no lo atiende nadie`);
  } else if (propio) {
    ok(`"${tema}" -> ${a.nombre}`);
  } else {
    console.log(`  [ojo]  "${tema}" -> ${a.nombre} (por respaldo: todavía no tiene bot propio)`);
  }
}

console.log("");
console.log(problemas === 0 ? "RESULTADO: el registro de agentes está sano ✅" : `RESULTADO: ${problemas} problema(s) ❌`);
process.exit(problemas === 0 ? 0 : 1);
