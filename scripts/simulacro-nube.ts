/**
 * SIMULACRO DE CARGA — varios clientes escribiéndole AL MISMO TIEMPO al bot ya desplegado.
 * =====================================================================================
 *
 * [2026-09-18] Pedido de Daniel: "podemos hacer una prueba como si le escribieran varios
 * clientes al tiempo al bot, tomando conversaciones del CRM y replicándolas".
 *
 * En qué se diferencia de `pruebas/simulacion-kommo.ts`, que ya existía:
 *   - Aquella corre el bot DENTRO de este proceso, un escenario detrás de otro. Sirve para
 *     revisar la CALIDAD de las respuestas (qué dice el bot y si se equivoca).
 *   - Esta le pega por HTTP al webhook del bot DESPLEGADO, con varias conversaciones en paralelo.
 *     Sirve para revisar que la infraestructura aguante: la cola, el debounce, el orden de los
 *     turnos de un mismo cliente, los tiempos de respuesta y que nadie se quede sin contestar.
 *
 * Los escenarios son los mismos (se importan de pruebas/simulacion-kommo.ts, que los sacó del
 * guion real del CRM — ver ANALISIS-VENTAS-KOMMO-2026-09-08.md), así que no hay dos listas que
 * mantener.
 *
 * ⚠️ SEGURIDAD — LEE ESTO ANTES DE CORRERLO
 * -----------------------------------------------------------------------------------------
 * El bot desplegado responde por WhatsApp DE VERDAD. Los números que inventa un simulacro caen
 * en prefijos reales de Colombia, así que sin protección le llegarían mensajes a personas que no
 * tienen nada que ver, desde el número del negocio.
 *
 * Por eso este script EXIGE que el bot desplegado tenga configurado `SIMULACRO_PREFIJOS` con el
 * prefijo que usa acá (ver PREFIJO, abajo, y src/channels/whatsapp-ycloud/adapter.ts). Con esa
 * variable puesta, el bot atiende a estos números con todo su pipeline normal —cola, agentes,
 * herramientas, base de datos— pero NO manda un solo WhatsApp: deja el mensaje en el log y en la
 * tabla `mensajes`, que es de donde este script lee las respuestas.
 *
 * Lo que SÍ queda escrito de verdad, y hay que limpiar después (ver LIMPIEZA, al final):
 * filas en `mensajes`, `estado_conversacion` y, si algún escenario llega a dar datos, en
 * `clientes` / `acompanantes` / `bloqueos_temporales`.
 *
 * Uso:
 *   SIMULACRO_URL=https://tu-bot.../webhooks/whatsapp \
 *   YCLOUD_WEBHOOK_SECRET=<el mismo de la nube> \
 *   npx tsx scripts/simulacro-nube.ts --confirmo-candado
 *
 *   --confirmo-candado   confirma que `SIMULACRO_PREFIJOS` ya está puesto en la nube Y
 *                        redesplegado. Sin este flag el script no manda nada.
 *   --clientes=6         cuántas conversaciones en paralelo (por defecto 5)
 *   --escenarios=F01,F03 solo esos ids
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { supabase, supabaseConfigured } from "../src/core/db/supabase.js";
import { FIJOS, type EscenarioFijo } from "../pruebas/simulacion-kommo.js";

// El prefijo de los números de simulacro. Tiene que coincidir con SIMULACRO_PREFIJOS de la nube.
const PREFIJO = "5730009";

/** Cuánto se espera la respuesta del bot antes de darla por perdida. */
const ESPERA_RESPUESTA_MS = 90_000;
/** Cada cuánto se le pregunta a la base si ya contestó. */
const SONDEO_MS = 1_500;
/** Pausa entre el mensaje del cliente y el siguiente, para que parezca una persona escribiendo. */
const PAUSA_ENTRE_MENSAJES_MS = 2_000;

const args = process.argv.slice(2);
const flag = (nombre: string) => args.some((a) => a === `--${nombre}`);
const valor = (nombre: string) => args.find((a) => a.startsWith(`--${nombre}=`))?.split("=")[1];

const URL_WEBHOOK = process.env.SIMULACRO_URL ?? "";
const SECRETO = process.env.YCLOUD_WEBHOOK_SECRET ?? "";
const CLIENTES = Number(valor("clientes") ?? 5);
const SOLO = (valor("escenarios") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function abortar(motivo: string): never {
  console.error(`\n❌ ${motivo}\n`);
  process.exit(1);
}

if (!URL_WEBHOOK) abortar("Falta SIMULACRO_URL — la URL del webhook del bot desplegado.");
if (!SECRETO) abortar("Falta YCLOUD_WEBHOOK_SECRET — sin él el webhook rechaza la firma (401).");
if (!supabaseConfigured) abortar("Falta la configuración de Supabase: de ahí se leen las respuestas del bot.");
if (!flag("confirmo-candado")) {
  abortar(
    "Falta --confirmo-candado.\n\n" +
      `   Antes de correr esto, en el bot DESPLEGADO tiene que estar puesto SIMULACRO_PREFIJOS=${PREFIJO}\n` +
      "   y el servicio redesplegado. Sin esa variable, el bot le manda WhatsApp DE VERDAD a cada\n" +
      "   número inventado de esta simulación — y esos números caen en prefijos reales de Colombia.\n\n" +
      "   Cuando lo confirmes, volvé a correrlo con --confirmo-candado."
  );
}

// ---- Un "cliente" del simulacro ------------------------------------------------------------

/** Número irrepetible por conversación, dentro del rango protegido. */
function numeroDe(indice: number): string {
  return `+${PREFIJO}${String(indice).padStart(3, "0")}`;
}

/** Firma el webhook igual que lo firmaría YCloud: t=<unix>,s=<hmac sha256 de "{t}.{body}">. */
async function mandarComoCliente(numero: string, texto: string): Promise<number> {
  const body = JSON.stringify({
    whatsappInboundMessage: {
      // El id importa: el bot descarta entregas repetidas por messageId (ver inboundQueue.ts),
      // así que cada mensaje del simulacro necesita el suyo o el segundo se perdería.
      id: `wamid.SIM.${crypto.randomUUID()}`,
      from: numero,
      type: "text",
      text: { body: texto },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const s = crypto.createHmac("sha256", SECRETO).update(`${t}.${body}`).digest("hex");
  const res = await fetch(URL_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ycloud-signature": `t=${t},s=${s}` },
    body,
  });
  return res.status;
}

/**
 * Espera a que el bot conteste. Como no hay WhatsApp de por medio, la respuesta se lee de la
 * tabla `mensajes`: se cuenta cuántas respuestas del bot había antes y se espera a que aparezca
 * una más. Devuelve null si se agotó el tiempo.
 */
async function esperarRespuesta(numero: string, respuestasPrevias: number): Promise<{ texto: string; ms: number } | null> {
  const arranque = Date.now();
  while (Date.now() - arranque < ESPERA_RESPUESTA_MS) {
    await new Promise((r) => setTimeout(r, SONDEO_MS));
    const { data } = await supabase
      .from("mensajes")
      .select("content,created_at")
      .eq("external_id", numero)
      .eq("role", "assistant")
      .order("created_at", { ascending: true });
    const filas = data ?? [];
    if (filas.length > respuestasPrevias) {
      return { texto: String(filas[filas.length - 1].content ?? ""), ms: Date.now() - arranque };
    }
  }
  return null;
}

interface TurnoDelSimulacro {
  cliente: string;
  bot: string | null;
  ms: number | null;
  httpStatus: number;
}

interface ResultadoConversacion {
  id: string;
  nombre: string;
  numero: string;
  turnos: TurnoDelSimulacro[];
  error?: string;
}

async function correrConversacion(esc: EscenarioFijo, indice: number): Promise<ResultadoConversacion> {
  const numero = numeroDe(indice);
  const turnos: TurnoDelSimulacro[] = [];
  try {
    for (const mensaje of esc.mensajesCliente) {
      // Cuántas respuestas hay AHORA, para saber cuál es la nueva.
      const { data: previas } = await supabase
        .from("mensajes")
        .select("id")
        .eq("external_id", numero)
        .eq("role", "assistant");
      const cuantasPrevias = (previas ?? []).length;

      const status = await mandarComoCliente(numero, mensaje);
      const respuesta = status === 200 ? await esperarRespuesta(numero, cuantasPrevias) : null;

      turnos.push({ cliente: mensaje, bot: respuesta?.texto ?? null, ms: respuesta?.ms ?? null, httpStatus: status });
      console.log(
        `  [${esc.id}] ${respuesta ? `respondió en ${(respuesta.ms / 1000).toFixed(1)}s` : `SIN RESPUESTA (http ${status})`}` +
          ` — "${mensaje.slice(0, 45)}"`
      );
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_MENSAJES_MS));
    }
    return { id: esc.id, nombre: esc.nombre, numero, turnos };
  } catch (err) {
    return { id: esc.id, nombre: esc.nombre, numero, turnos, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Hallazgos automáticos -----------------------------------------------------------------

/**
 * Lo que se revisa solo, sin leer las transcripciones a mano. Son los problemas que ya se vieron
 * en producción, no una lista teórica: turnos sin respuesta, respuestas repetidas (el duplicado
 * de webhook del 2026-09-17), escalamientos y demoras.
 */
function hallazgosDe(r: ResultadoConversacion): string[] {
  const out: string[] = [];
  const sinRespuesta = r.turnos.filter((t) => !t.bot).length;
  if (sinRespuesta > 0) out.push(`${sinRespuesta} turno(s) sin respuesta`);

  const respuestas = r.turnos.map((t) => (t.bot ?? "").trim()).filter(Boolean);
  const repetidas = respuestas.filter((t, i) => i > 0 && t === respuestas[i - 1]).length;
  if (repetidas > 0) out.push(`${repetidas} respuesta(s) idénticas seguidas`);

  if (respuestas.some((t) => /te comunico con el equipo|ya quedó con el equipo/i.test(t))) {
    out.push("escaló a un humano");
  }
  const tiempos = r.turnos.map((t) => t.ms).filter((m): m is number => m != null);
  const lento = tiempos.filter((m) => m > 30_000).length;
  if (lento > 0) out.push(`${lento} respuesta(s) tardaron más de 30s`);
  if (r.error) out.push(`error del simulacro: ${r.error}`);
  return out;
}

// ---- Main ----------------------------------------------------------------------------------

const elegidos = (SOLO.length > 0 ? FIJOS.filter((e) => SOLO.includes(e.id)) : FIJOS).slice(0, CLIENTES);
if (elegidos.length === 0) abortar(`Ningún escenario coincide con ${JSON.stringify(SOLO)}.`);

console.log("\n" + "█".repeat(92));
console.log(`  SIMULACRO DE CARGA — ${elegidos.length} clientes EN PARALELO contra el bot desplegado`);
console.log("█".repeat(92));
console.log(`  webhook   : ${URL_WEBHOOK}`);
console.log(`  números   : ${numeroDe(0)} … ${numeroDe(elegidos.length - 1)}  (protegidos por SIMULACRO_PREFIJOS)`);
console.log(`  escenarios: ${elegidos.map((e) => e.id).join(", ")}`);
console.log("");

const arranque = Date.now();
// TODAS a la vez a propósito: es justo lo que se quiere medir (varios clientes al mismo tiempo).
const resultados = await Promise.all(elegidos.map((esc, i) => correrConversacion(esc, i)));
const duracion = ((Date.now() - arranque) / 1000).toFixed(1);

const todosLosTiempos = resultados.flatMap((r) => r.turnos.map((t) => t.ms).filter((m): m is number => m != null));
const promedio = todosLosTiempos.length > 0 ? todosLosTiempos.reduce((a, b) => a + b, 0) / todosLosTiempos.length : 0;
const peor = todosLosTiempos.length > 0 ? Math.max(...todosLosTiempos) : 0;
const totalTurnos = resultados.reduce((n, r) => n + r.turnos.length, 0);
const sinRespuesta = resultados.reduce((n, r) => n + r.turnos.filter((t) => !t.bot).length, 0);

console.log("\n" + "█".repeat(92));
console.log("  RESULTADO");
console.log("█".repeat(92));
console.log(`  duración total        : ${duracion}s`);
console.log(`  turnos                : ${totalTurnos} (${sinRespuesta} sin respuesta)`);
console.log(`  respuesta promedio    : ${(promedio / 1000).toFixed(1)}s`);
console.log(`  la más lenta          : ${(peor / 1000).toFixed(1)}s`);
console.log("");
for (const r of resultados) {
  const h = hallazgosDe(r);
  console.log(`  ${h.length === 0 ? "✅" : "⚠️ "} ${r.id} ${r.nombre}${h.length > 0 ? `\n       ${h.join("\n       ")}` : ""}`);
}

// Transcripción completa, para poder leer qué contestó el bot en cada turno.
const carpeta = path.join(process.cwd(), "pruebas", "resultados");
fs.mkdirSync(carpeta, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const ruta = path.join(carpeta, `simulacro-nube-${stamp}.md`);
const md = [
  `# Simulacro de carga contra el bot desplegado — ${new Date().toLocaleString("es-CO")}`,
  ``,
  `- Webhook: \`${URL_WEBHOOK}\``,
  `- ${elegidos.length} conversaciones en paralelo, ${totalTurnos} turnos, ${sinRespuesta} sin respuesta`,
  `- Respuesta promedio ${(promedio / 1000).toFixed(1)}s, la más lenta ${(peor / 1000).toFixed(1)}s`,
  ``,
  ...resultados.flatMap((r) => [
    `## ${r.id} — ${r.nombre}`,
    ``,
    `Número: \`${r.numero}\`${r.error ? ` · ERROR: ${r.error}` : ""}`,
    ``,
    ...r.turnos.flatMap((t) => [
      `**Cliente:** ${t.cliente}`,
      ``,
      `**Bot** (${t.ms != null ? `${(t.ms / 1000).toFixed(1)}s` : `SIN RESPUESTA, http ${t.httpStatus}`}): ${t.bot ?? "—"}`,
      ``,
    ]),
  ]),
].join("\n");
fs.writeFileSync(ruta, md, "utf-8");
console.log(`\n  Transcripción: ${ruta}`);

// LIMPIEZA: lo que este simulacro dejó escrito en la base, para borrarlo cuando termines.
console.log(
  `\n  Para limpiar lo que dejó en la base (SQL Editor de Supabase):\n` +
    `    delete from mensajes            where external_id like '+${PREFIJO}%';\n` +
    `    delete from estado_conversacion where external_id like '+${PREFIJO}%';\n` +
    `    delete from bloqueos_temporales where external_id like '+${PREFIJO}%';\n` +
    `    -- revisá antes de borrar, por si algún escenario llegó a registrar un cliente:\n` +
    `    select * from clientes where celular like '%${PREFIJO}%';\n`
);
console.log("█".repeat(92) + "\n");
