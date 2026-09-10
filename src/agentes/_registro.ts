import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../core/tools/types.js";
import type { DefinicionAgente } from "./_tipos.js";

/**
 * [2026-09-10] Descubre los agentes solo, leyendo las carpetas de src/agentes/.
 *
 * La regla es simple: **una carpeta con un `agente.ts` adentro es un bot**. Se ignoran las
 * carpetas que empiezan con "_" (archivos comunes) y las que todavía no tienen `agente.ts`
 * (territorio marcado para un bot que no se construyó — ver src/agentes/reservas/ y pagos/).
 *
 * El objetivo es que NADIE tenga que editar un archivo compartido para sumar o cambiar un bot:
 * antes, el registro de herramientas y el pipeline del turno eran los dos archivos que todos
 * tocaban, y con varias personas en ramas distintas eso era conflicto de merge asegurado.
 * Ahora cada uno trabaja solo dentro de su carpeta.
 */

const CARPETA_AGENTES = path.join(process.cwd(), "src", "agentes");

/** El agente que atiende los temas sin bot propio. Si algo falla, todo cae acá. */
const AGENTE_POR_DEFECTO = "ventas";

let cache: DefinicionAgente[] | null = null;

function carpetasDeAgentes(): string[] {
  try {
    return fs
      .readdirSync(CARPETA_AGENTES, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .filter((nombre) => fs.existsSync(path.join(CARPETA_AGENTES, nombre, "agente.ts")))
      .sort();
  } catch (err) {
    console.error("[agentes] no pude leer src/agentes/:", err);
    return [];
  }
}

/**
 * Carga (una vez) todas las definiciones de agente. Un agente que falle al cargar se saltea con
 * un error en el log en vez de tumbar el arranque: si alguien rompe su bot en su rama, los demás
 * siguen funcionando.
 */
export async function cargarAgentes(): Promise<DefinicionAgente[]> {
  if (cache) return cache;

  const encontrados: DefinicionAgente[] = [];
  for (const carpeta of carpetasDeAgentes()) {
    try {
      // Con tsx el ".js" resuelve al ".ts" hermano, igual que en el resto del proyecto.
      const modulo = (await import(`./${carpeta}/agente.js`)) as { agente?: DefinicionAgente };
      const agente = modulo.agente;
      if (!agente?.nombre || !Array.isArray(agente.atiende) || !agente.prompt) {
        console.error(
          `[agentes] src/agentes/${carpeta}/agente.ts no exporta un \`agente\` válido ` +
            "(hacen falta nombre, atiende[] y prompt) — se ignora."
        );
        continue;
      }
      encontrados.push(agente);
    } catch (err) {
      console.error(`[agentes] fallé al cargar src/agentes/${carpeta}/agente.ts — se ignora:`, err);
    }
  }

  // Dos agentes que digan atender el mismo tema es un error de configuración: manda el primero
  // por orden alfabético y se avisa, porque si no el comportamiento cambiaría según el orden en
  // que se lean las carpetas.
  const dueño = new Map<string, string>();
  for (const a of encontrados) {
    for (const tema of a.atiende) {
      const ya = dueño.get(tema);
      if (ya) {
        console.error(
          `[agentes] "${tema}" lo declaran DOS agentes: "${ya}" y "${a.nombre}". Se usa "${ya}" — ` +
            `saca ese tema del \`atiende\` de uno de los dos.`
        );
      } else {
        dueño.set(tema, a.nombre);
      }
    }
  }

  if (encontrados.length === 0) console.error("[agentes] no encontré ningún agente en src/agentes/");
  else console.log(`[agentes] cargados: ${encontrados.map((a) => `${a.nombre}(${a.atiende.join("|")})`).join(", ")}`);

  cache = encontrados;
  return cache;
}

/**
 * El agente que le toca a una decisión del orquestador. Si ese tema no tiene agente (o el
 * agente no cargó), cae al de por defecto para no dejar al cliente sin respuesta.
 */
export async function agenteQueAtiende(tema: string): Promise<DefinicionAgente | null> {
  const agentes = await cargarAgentes();
  const propio = agentes.find((a) => a.atiende.includes(tema));
  if (propio) return propio;

  const respaldo = agentes.find((a) => a.nombre === AGENTE_POR_DEFECTO) ?? agentes[0] ?? null;
  if (respaldo) {
    console.warn(`[agentes] no hay agente para "${tema}": lo atiende "${respaldo.nombre}".`);
  }
  return respaldo;
}

/** Las herramientas de un agente por nombre — para los scripts de diagnóstico. */
export async function herramientasDe(nombreAgente: string): Promise<ToolDefinition[]> {
  const agentes = await cargarAgentes();
  return agentes.find((a) => a.nombre === nombreAgente)?.herramientas ?? [];
}

// --- Lo que el pipeline necesita de un juego de herramientas -------------------------------

export async function esquemasDeHerramientas(herramientas: ToolDefinition[]) {
  return Promise.all(
    herramientas.map(async (t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.getParameters ? await t.getParameters().catch(() => t.parameters) : t.parameters,
      },
    }))
  );
}

/** La definición completa (para leer banderas como permitirRedaccion). */
export function buscarHerramienta(nombre: string, herramientas: ToolDefinition[]): ToolDefinition | undefined {
  return herramientas.find((t) => t.name === nombre);
}

export function handlerDeHerramienta(nombre: string, herramientas: ToolDefinition[]) {
  const herramienta = herramientas.find((t) => t.name === nombre);
  if (!herramienta) throw new Error(`Herramienta desconocida: ${nombre}`);
  return herramienta.handler;
}
