import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../core/tools/types.js";

/**
 * [2026-09-10] Contrato de un agente (un "bot"). Cada agente vive en su propia carpeta bajo
 * src/agentes/ con TODO lo suyo adentro: su prompt, sus herramientas y este archivo de
 * definición. Nadie tiene que editar un archivo común para sumar o cambiar un bot — el registro
 * (./_registro.ts) descubre las carpetas solo.
 *
 * Por qué está armado así: antes había dos archivos que TODOS tenían que tocar para cambiar
 * cualquier bot (el registro de herramientas y el pipeline del turno). Con varias personas
 * trabajando en ramas distintas, esos dos archivos eran conflicto de merge garantizado.
 */
export interface DefinicionAgente {
  /** Nombre de la carpeta / del bot. Solo para logs y diagnóstico. */
  nombre: string;

  /**
   * Qué valores de `decision.agente` del orquestador atiende este bot (ver
   * src/agentes/orquestador/prompt.md). Normalmente es uno solo y coincide con `nombre`.
   *
   * Puede ser más de uno mientras un bot cubra temas que todavía no tienen su propio agente:
   * hoy `ventas` atiende "informacion", "reservas" y "pagos". Cuando alguien construya el bot
   * de pagos, crea src/agentes/pagos/agente.ts y lo saca de esta lista — sin tocar nada de nadie.
   */
  atiende: string[];

  /**
   * El prompt específico de este agente. Se le manda al modelo DESPUÉS del prompt base
   * (src/agentes/_base.md), que trae la persona, el tono y las reglas que valen para todos.
   */
  prompt: string;

  /** Las herramientas que este agente puede llamar. */
  herramientas: ToolDefinition[];
}

/**
 * Lee el prompt que está al lado del archivo del agente: `leerPromptDeAgente("postventa")`
 * devuelve src/agentes/postventa/prompt.md.
 *
 * Se resuelve desde la raíz del proyecto (process.cwd()), igual que el resto de las lecturas de
 * prompts del bot — el proyecto corre con tsx, sin paso de build.
 */
export function leerPromptDeAgente(carpeta: string, archivo = "prompt.md"): string {
  return fs.readFileSync(path.join(process.cwd(), "src", "agentes", carpeta, archivo), "utf-8");
}

/** El prompt base, común a todos los agentes (persona, tono, regla de precios, correcciones). */
export function leerPromptBase(): string {
  return fs.readFileSync(path.join(process.cwd(), "src", "agentes", "_base.md"), "utf-8");
}
