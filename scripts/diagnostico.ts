/**
 * Banco de pruebas de diagnóstico — creado el 2026-09-08 para auditar de punta a punta el
 * bot de La Julita: configuración, Supabase (tablas y datos), las herramientas, el
 * orquestador, el modelo (¿existe?, ¿llama las herramientas?), el pipeline completo con un
 * adaptador falso, el canal de WhatsApp (firma + parseo del webhook, y credenciales de
 * YCloud) y la cola de Redis con sus trabajos fallidos.
 *
 * NO manda mensajes reales de WhatsApp salvo que se lo pidas explícitamente.
 *
 *   npx tsx scripts/diagnostico.ts
 *
 * Deja el reporte completo en `diagnostico-<fecha>.txt` en la raíz del proyecto (además de
 * imprimirlo en la consola).
 *
 * Opcional, manda UN mensaje real de prueba por YCloud al número que le pases:
 *   npx tsx scripts/diagnostico.ts --enviar-whatsapp=+573XXXXXXXXX
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import axios from "axios";
import type { ChannelAdapter } from "../src/channels/types.js";
import { supabase, supabaseConfigured } from "../src/core/db/supabase.js";
import { planesRepo, adicionalesRepo, getConfiguracion, getDomosYClases } from "../src/core/db/catalogoRepo.js";
import { listFaq } from "../src/core/db/faqRepo.js";
import { getEstado } from "../src/core/db/estadoRepo.js";
import { listMensajes } from "../src/core/db/mensajesRepo.js";
import { herramientasDe, esquemasDeHerramientas } from "../src/agentes/_registro.js";
import { consultarPlanesTool, consultarAdicionalesTool, consultarHorariosTool } from "../src/agentes/ventas/herramientas/planes.js";
import { preguntasFrecuentesTool } from "../src/agentes/ventas/herramientas/preguntasFrecuentes.js";
import { registrarDatosReservaTool } from "../src/agentes/ventas/herramientas/reserva.js";
import { resolverTipoDocumento, buscarReservasConfirmadasPorCelular } from "../src/core/db/reservasRepo.js";
import { buscarReservaClienteTool } from "../src/agentes/postventa/herramientas/buscarReserva.js";
import { listCorrecciones, agregarCorreccion, desactivarCorreccion, bloqueDeCorrecciones } from "../src/core/db/correccionesRepo.js";
import {
  consultarDisponibilidad,
  consultarDisponibilidadPorDia,
  buscarFechasAlternativas,
  estadoUltimaConsultaOficial,
  apiOficialConfigurada,
} from "../src/core/integrations/lobbypms.js";
import { consultarFechasAlternativasTool } from "../src/agentes/ventas/herramientas/disponibilidad.js";
import {
  crearBloqueo,
  contarBloqueosActivos,
  confirmarBloqueo,
  liberarBloqueoSiVencido,
  bloqueosPendientes,
} from "../src/core/db/bloqueosRepo.js";
import { intentarComando, esNumeroAutorizado, numerosAutorizados, puedeCorregir } from "../src/core/pipeline/comandos.js";
import { cerrarSesion } from "../src/core/db/sesionesRepo.js";
import { openrouter, LLM_MODEL, ORCHESTRATOR_MODEL } from "../src/core/llm/openrouter.js";
import { enrutarMensaje } from "../src/agentes/orquestador/route.js";
import { handleInbound } from "../src/core/pipeline/runTurn.js";
import { verifyYCloudSignature } from "../src/channels/whatsapp-ycloud/signature.js";
import { parseYcloudWebhook } from "../src/channels/whatsapp-ycloud/adapter.js";
import { sendTextMessage } from "../src/channels/whatsapp-ycloud/client.js";
import { getRedisConnection } from "../src/core/queue/redis.js";
import { getInboundQueue } from "../src/core/queue/inboundQueue.js";
import { getRecontactoQueue, PASOS_MS, MAX_PASOS, RECONTACTO_HABILITADO } from "../src/core/queue/recontactoQueue.js";
import { esHorarioNocturno, ajustarPorHorarioNocturno } from "../src/core/lib/horarioNocturno.js";

// [2026-09-10] Las herramientas ahora viven en la carpeta de su agente (src/agentes/<bot>/).
const tools = await herramientasDe("ventas");

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const REPORTE = path.join(process.cwd(), `diagnostico-${stamp}.txt`);
const problemas: string[] = [];
const avisos: string[] = [];

function log(...partes: unknown[]): void {
  const linea = partes.map((p) => (typeof p === "string" ? p : JSON.stringify(p, null, 2))).join(" ");
  console.log(linea);
  fs.appendFileSync(REPORTE, linea + "\n", "utf-8");
}
function seccion(titulo: string): void {
  log("");
  log("=".repeat(88));
  log("== " + titulo);
  log("=".repeat(88));
}
function problema(txt: string): void {
  problemas.push(txt);
  log("  [PROBLEMA] " + txt);
}
function aviso(txt: string): void {
  avisos.push(txt);
  log("  [AVISO]    " + txt);
}
function ok(txt: string): void {
  log("  [OK]       " + txt);
}
function errTxt(e: unknown): string {
  const a = e as any;
  if (a?.response) return `HTTP ${a.response.status} — ${JSON.stringify(a.response.data).slice(0, 500)}`;
  return a?.message ?? String(e);
}
function ms(desde: number): string {
  return `${Date.now() - desde}ms`;
}

const SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), "prompts", "system.md"), "utf-8");

// Tope real de un mensaje de texto de WhatsApp. Pasarse de acá es silencioso: YCloud acepta
// la petición y el cliente no recibe nada (fue la causa raíz encontrada el 2026-09-08).
const LIMITE_WHATSAPP = 4096;

// ============================================================================================
async function s1Configuracion(): Promise<void> {
  seccion("1. CONFIGURACIÓN (.env)");
  const requeridas = [
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "REDIS_URL",
    "YCLOUD_API_KEY",
    "YCLOUD_WEBHOOK_SECRET",
    "YCLOUD_FROM_PHONE_NUMBER",
  ];
  const opcionales = ["ORCHESTRATOR_MODEL", "YCLOUD_DRY_RUN", "YCLOUD_BASE_URL", "PORT", "ADMIN_PASSWORD", "SESSION_SECRET"];
  const secreta = /KEY|SECRET|PASSWORD|TOKEN|SERVICE_ROLE|REDIS_URL/i;

  for (const k of requeridas) {
    const v = process.env[k];
    if (!v) problema(`falta la variable requerida ${k}`);
    else if (secreta.test(k)) ok(`${k} definida (largo ${v.length})`);
    else ok(`${k} = ${v}`);
  }
  for (const k of opcionales) {
    const v = process.env[k];
    if (!v) aviso(`${k} sin definir (se usa el valor por defecto del código)`);
    else if (secreta.test(k)) ok(`${k} definida (largo ${v.length})`);
    else ok(`${k} = ${v}`);
  }
  log("");
  log(`  modelo de los agentes    : ${LLM_MODEL}`);
  log(`  modelo del orquestador   : ${ORCHESTRATOR_MODEL}`);
  log(`  supabaseConfigured       : ${supabaseConfigured}`);
  log(`  YCLOUD_DRY_RUN activo    : ${process.env.YCLOUD_DRY_RUN === "true"}`);
  if (!process.env.ADMIN_PASSWORD) problema("ADMIN_PASSWORD vacío: el panel /admin queda sin contraseña real");
  if (!process.env.SESSION_SECRET) problema("SESSION_SECRET vacío: las cookies del panel se firman con el valor por defecto del código");
}

// ============================================================================================
async function s2Supabase(): Promise<void> {
  seccion("2. SUPABASE — existencia de tablas y conteo de filas");
  if (!supabaseConfigured) {
    problema("Supabase no está configurado: no se puede probar nada de base de datos");
    return;
  }
  const objetos = [
    "clase_domo", "domos", "planes", "tipo_adicional", "adicionales",
    "tipo_documento", "clientes", "estado", "reservas", "acompanantes",
    "adicionales_reserva", "mensajes", "estado_conversacion", "faq",
    "configuracion", "fechas_bloqueadas", "conversaciones",
  ];
  for (const t of objetos) {
    const t0 = Date.now();
    try {
      const { count, error } = await supabase.from(t).select("*", { count: "exact", head: true });
      if (error) problema(`${t}: ${error.code ?? "?"} — ${error.message} (${ms(t0)})`);
      else ok(`${t}: ${count} filas (${ms(t0)})`);
    } catch (e) {
      problema(`${t}: excepción — ${errTxt(e)}`);
    }
  }
}

// ============================================================================================
async function s3Datos(): Promise<void> {
  seccion("3. SUPABASE — datos reales que usa el bot");
  if (!supabaseConfigured) return;

  try {
    const { data, error } = await supabase.from("planes").select("*").order("id");
    if (error) problema(`no se pudo leer planes: ${error.message}`);
    else {
      log(`  filas totales en planes: ${data?.length ?? 0}`);
      for (const p of data ?? []) {
        log(
          `   - id=${p.id} activo=${p.activo} nombre=${JSON.stringify(p.nombre)} ` +
            `semana=${p.precio_entre_semana} finde=${p.precio_fin_de_semana} puente=${p.precio_fin_de_semana_puente}`
        );
      }
      const activos = (data ?? []).filter((p: any) => p.activo === true);
      if ((data?.length ?? 0) === 0) problema("la tabla planes está VACÍA — consultar_planes nunca podrá dar precios");
      else if (activos.length === 0) problema("hay planes pero NINGUNO tiene activo=true — consultar_planes los filtra y devuelve vacío");
      else ok(`${activos.length} plan(es) con activo=true`);
      const sinPrecio = activos.filter(
        (p: any) => p.precio_entre_semana == null && p.precio_fin_de_semana == null && p.precio_fin_de_semana_puente == null
      );
      if (sinPrecio.length > 0) problema(`${sinPrecio.length} plan(es) activo(s) sin ningún precio: saldrían como "precio no disponible"`);
    }
  } catch (e) {
    problema(`planes: excepción — ${errTxt(e)}`);
  }

  try {
    const lista = await planesRepo.list(true);
    log(`  planesRepo.list(true) devolvió ${lista.length} fila(s)`);
    if (lista.length === 0) problema("planesRepo.list(true) devuelve 0 filas: el bot va a responder 'Todavía no tengo los planes cargados'");
  } catch (e) {
    problema(`planesRepo.list: excepción — ${errTxt(e)}`);
  }

  try {
    const { domos, clases } = await getDomosYClases();
    log("");
    log(`  clase_domo: ${JSON.stringify(clases)}`);
    log(`  domos: ${JSON.stringify(domos)}`);
    // [2026-09-09] Sin `capacidad`: esa columna NO existe en `planes` y pedirla hacía que
    // TODA esta lectura fallara con 42703, reportando un problema que era de este script.
    const { data, error } = await supabase.from("planes").select("id,nombre,domos_id").order("id");
    if (error) {
      // Antes este error se ignoraba y el reporte concluía "ningún plan tiene domos_id" sobre
      // un arreglo vacío — un dato falso que me hizo perder tiempo persiguiendo un fantasma.
      problema(`no se pudo leer id/nombre/domos_id de planes: ${error.code ?? "?"} — ${error.message}`);
    } else {
      const filas = data ?? [];
      log("");
      for (const p of filas) {
        log(`   - id=${p.id} domos_id=${JSON.stringify(p.domos_id)} ${p.nombre}`);
      }
      const conDomos = filas.filter((p: any) => Array.isArray(p.domos_id) && p.domos_id.length > 0);
      log(`  planes con domos_id cargado: ${conDomos.length} de ${filas.length}`);
      if (filas.length > 0 && conDomos.length === 0) {
        aviso("ningún plan tiene `domos_id`: el tipo de alojamiento se deduce del nombre y la descripción.");
      }
    }
  } catch (e) {
    problema(`no se pudo leer domos/clase_domo: ${errTxt(e)}`);
  }

  for (const [nombre, fn] of [
    ["adicionalesRepo.list(true)", () => adicionalesRepo.list(true)],
    ["getConfiguracion()", () => getConfiguracion()],
    ["listFaq()", () => listFaq(true)],
  ] as [string, () => Promise<unknown>][]) {
    try {
      const r = await fn();
      log(`  ${nombre} -> ${JSON.stringify(r).slice(0, 300)}`);
    } catch (e) {
      problema(`${nombre}: excepción — ${errTxt(e)}`);
    }
  }
}

// ============================================================================================
async function s4Herramientas(): Promise<void> {
  seccion("4. HERRAMIENTAS — qué ve el modelo y qué devuelve cada una");
  log(`  herramientas REGISTRADAS (las que el modelo puede llamar): ${tools.map((t) => t.name).join(", ") || "(ninguna)"}`);
  try {
    const schemas = await esquemasDeHerramientas(await herramientasDe("ventas"));
    log(`  esquemas enviados al modelo: ${JSON.stringify(schemas.map((s: any) => s.function.name))}`);
  } catch (e) {
    problema(`getToolSchemas falló: ${errTxt(e)}`);
  }
  const menciones = ["consultar_planes", "preguntas_frecuentes", "consultar_adicionales", "consultar_horarios"]
    .filter((n) => SYSTEM_PROMPT.includes(n));
  log(`  herramientas mencionadas en src/agentes/ventas/prompt.md: ${menciones.join(", ")}`);
  for (const n of menciones) {
    if (!tools.some((t) => t.name === n) && !SYSTEM_PROMPT.includes(`NO están disponibles`)) {
      aviso(`system.md menciona "${n}" pero NO está registrada — si el modelo la llama, la herramienta truena ("Herramienta desconocida")`);
    }
  }

  const ctx = { channel: "diagnostico", externalId: "diag" };

  log("");
  log("  --- consultar_planes con argumentos (el flujo nuevo: de a 3) ---");
  const casos: [string, Record<string, unknown>][] = [
    ["sin argumentos", {}],
    ["personas=2", { personas: 2 }],
    ["personas=2, fecha=sábado (menú de 3 experiencias)", { personas: 2, fecha: "2026-12-19" }],
    ["nivel=por_noche", { personas: 2, fecha: "2026-12-19", nivel: "por_noche" }],
    ["nivel=intermedio", { personas: 2, fecha: "2026-12-19", nivel: "intermedio" }],
    ["nivel=todo_incluido", { personas: 2, fecha: "2026-12-19", nivel: "todo_incluido" }],
    ["personas=2, ocasion=aniversario, fecha=sábado", { personas: 2, ocasion: "aniversario", fecha: "2026-12-19" }],
    ["personas=2, fecha=martes (entre semana)", { personas: 2, fecha: "2026-12-15" }],
    ["personas=2, fecha=sábado + festivo", { personas: 2, fecha: "2026-12-19", festivo: true }],
    ["personas=4, ocasion=familia", { personas: 4, ocasion: "familia" }],
    ["personas=3, ocasion=amigas", { personas: 3, ocasion: "amigas" }],
    ["personas=2, pagina=2 (ver otras)", { personas: 2, pagina: 2 }],
    ["personas=2, pagina=5 (pasado el final)", { personas: 2, pagina: 5 }],
    ["personas=2, tipo=pasadia", { personas: 2, tipo: "pasadia" }],
    ["segmento=pasadia, personas=2", { segmento: "pasadia", personas: 2 }],
    ["segmento=pareja, nivel=por_noche (no debe colarse un plan de 3)", { segmento: "pareja", personas: 2, nivel: "por_noche" }],
    ["personas=2, tipo=dos_noches", { personas: 2, tipo: "dos_noches" }],
    ["plan='paraiso' (detalle)", { plan: "paraiso" }],
    ["plan='paraiso' + fecha (un solo precio)", { plan: "paraiso", fecha: "2026-12-19" }],
    ["plan='familiar' (ambiguo a propósito)", { plan: "familiar" }],
    ["plan='no existe este plan'", { plan: "no existe este plan" }],
  ];
  for (const [etiqueta, argumentos] of casos) {
    const t1 = Date.now();
    try {
      const r = await consultarPlanesTool.handler(argumentos, ctx);
      const largo = (r.reply_to_user ?? "").length;
      const cuantos = Array.isArray((r.result as any)?.mostrados) ? (r.result as any).mostrados.length : "-";
      log("");
      log(`   > ${etiqueta} — ${largo} caracteres, planes mostrados: ${cuantos}`);
      log(`     ${(r.reply_to_user ?? "").replace(/\n/g, "\n     ")}`);
      if (largo > LIMITE_WHATSAPP) problema(`consultar_planes(${etiqueta}) devuelve ${largo} caracteres: pasa el límite de WhatsApp`);
      if (typeof cuantos === "number" && cuantos > 3) problema(`consultar_planes(${etiqueta}) devolvió ${cuantos} planes: debería mostrar máximo 3`);
      const cuerpo = r.reply_to_user ?? "";
      if (/\$ ?0(?!\d)/.test(cuerpo)) problema(`consultar_planes(${etiqueta}) le muestra un precio de $ 0 al cliente`);
      // [2026-09-09] A una pareja no se le ofrece un plan de 3 o 4 personas: le cabe por
      // número, pero no es lo que le estamos vendiendo (así aparecía "PLAN AMIGAS 3").
      if (Number(argumentos.personas) === 2 && /AMIGAS|FAMILIAR/i.test(cuerpo)) {
        problema(`consultar_planes(${etiqueta}) le ofrece a una pareja un plan de amigas/familiar`);
      }
      // Un pasadía no incluye noche: el menú de "planes por noche" ahí decía mentiras.
      const esPasadia = argumentos.tipo === "pasadia" || argumentos.segmento === "pasadia";
      if (esPasadia && /Planes por noche|UNA NOCHE|DOS NOCHES/i.test(cuerpo)) {
        problema(`consultar_planes(${etiqueta}) mezcla texto de "noche" en una consulta de pasadía`);
      }
      if (esPasadia && !/pasadia|pasadía/i.test(cuerpo)) {
        problema(`consultar_planes(${etiqueta}) no muestra ningún pasadía`);
      }
      if (argumentos.fecha && (cuerpo.match(/entre semana|fin de semana/g) ?? []).length > 3) {
        aviso(`consultar_planes(${etiqueta}) con fecha sigue mostrando varias tarifas: debería cotizar una sola`);
      }
    } catch (e) {
      problema(`consultar_planes(${etiqueta}) lanzó excepción: ${errTxt(e)}`);
    }
  }
  for (const [nombre, correr] of [
    ["consultar_planes (ACTIVA)", () => consultarPlanesTool.handler({}, ctx)],
    ["consultar_adicionales (ACTIVA)", () => consultarAdicionalesTool.handler({}, ctx)],
    ["consultar_horarios (desactivada)", () => consultarHorariosTool.handler({}, ctx)],
    ["preguntas_frecuentes (desactivada)", () => preguntasFrecuentesTool.handler({ tema: "ubicacion" }, ctx)],
  ] as [string, () => Promise<any>][]) {
    const t0 = Date.now();
    try {
      const r = await correr();
      const largo = (r.reply_to_user ?? "").length;
      log("");
      log(`  --- ${nombre} (${ms(t0)}) ---`);
      log(`  largo de reply_to_user: ${largo} caracteres (máximo de un mensaje de WhatsApp: ${LIMITE_WHATSAPP})`);
      log(`  reply_to_user: ${JSON.stringify(r.reply_to_user)}`);
      if (largo > LIMITE_WHATSAPP) {
        problema(
          `${nombre} devuelve ${largo} caracteres: pasa el límite de WhatsApp (${LIMITE_WHATSAPP}), ` +
            `así que ese mensaje NO le llega al cliente aunque el bot crea que respondió`
        );
      }
    } catch (e) {
      problema(`${nombre} lanzó excepción: ${errTxt(e)}`);
    }
  }
}

// ============================================================================================
async function s5Modelo(): Promise<void> {
  seccion("5. MODELO (OpenRouter) — ¿existe el modelo?, ¿responde?, ¿llama la herramienta?");

  try {
    const t0 = Date.now();
    const res = await axios.get("https://openrouter.ai/api/v1/models", { timeout: 30_000 });
    const ids: string[] = (res.data?.data ?? []).map((m: any) => m.id);
    log(`  catálogo de OpenRouter: ${ids.length} modelos (${ms(t0)})`);
    if (ids.includes(LLM_MODEL)) ok(`el modelo configurado existe: ${LLM_MODEL}`);
    else {
      problema(`el modelo configurado NO existe en OpenRouter: "${LLM_MODEL}"`);
      log(`  modelos deepseek disponibles: ${ids.filter((i) => i.includes("deepseek")).join(", ")}`);
    }
  } catch (e) {
    aviso(`no se pudo leer el catálogo de modelos: ${errTxt(e)}`);
  }

  try {
    const t0 = Date.now();
    const c = await openrouter.chat.completions.create({
      model: LLM_MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "Hola" }] as any,
    });
    ok(`llamada simple al modelo OK (${ms(t0)}) — respuesta: ${JSON.stringify(c.choices[0]?.message?.content)}`);
  } catch (e) {
    problema(`la llamada simple al modelo FALLÓ: ${errTxt(e)}`);
    return;
  }

  const schemas = await esquemasDeHerramientas(await herramientasDe("ventas"));

  // [2026-09-08] Este test estaba MAL planteado: mandaba una frase de precios sin contexto y
  // exigía una llamada a la herramienta. Con el flujo nuevo lo correcto es justo lo contrario —
  // primero se pregunta el tipo de grupo y la fecha. Ahora se prueban las dos mitades:
  //   1. en frío, el bot debe PREGUNTAR y no soltar precios;
  //   2. cuando el cliente ya contestó, ahí sí debe llamar la herramienta con esos datos.
  const frases = [
    "quiero ver los planes y precios",
    "Hola quiero conocer los planes",
    "si quiero conocer que planes tienes",
    "cuanto vale una noche?",
    "cuales son los precios de fin de semana",
  ];
  const REPS = 2;
  const hoy = `Para tu referencia: hoy es ${new Date().toISOString().slice(0, 10)} en Colombia.`;

  let preguntoSinPrecios = 0;
  let llamoTrasResponder = 0;
  let total = 0;

  log("");
  log(`  Prueba en dos turnos: ${frases.length} frases x ${REPS} repeticiones`);
  for (const frase of frases) {
    for (let i = 0; i < REPS; i++) {
      total++;
      try {
        // --- Turno 1: en frío ---
        const c1 = await openrouter.chat.completions.create({
          model: LLM_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "system", content: hoy },
            { role: "user", content: frase },
          ] as any,
          tools: schemas as any,
          temperature: 0.3,
        });
        const m1 = c1.choices[0]?.message;
        const texto1 = (m1?.content ?? "").trim();
        const llamo1 = (m1?.tool_calls ?? []).length > 0;
        const traePrecio = /\$\s?\d|\b\d{1,3}(?:[.,]\d{3})+\b/.test(texto1);

        if (!llamo1 && !traePrecio && /\?/.test(texto1)) {
          preguntoSinPrecios++;
          log(`   [turno 1 ok] "${frase}" -> pregunta sin soltar precios`);
        } else if (traePrecio && !llamo1) {
          problema(`en frío, con "${frase}", el modelo escribió precios de su propia cabeza: ${JSON.stringify(texto1.slice(0, 160))}`);
        } else if (llamo1) {
          // Llamar de una no está mal si pasa datos; se anota como aceptable.
          preguntoSinPrecios++;
          log(`   [turno 1 ok] "${frase}" -> llamó la herramienta directo`);
        } else {
          aviso(`en frío, con "${frase}", no preguntó nada ni llamó la herramienta: ${JSON.stringify(texto1.slice(0, 120))}`);
        }

        // --- Turno 2: el cliente ya contestó grupo y fecha ---
        const c2 = await openrouter.chat.completions.create({
          model: LLM_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "system", content: hoy },
            { role: "user", content: frase },
            { role: "assistant", content: texto1 || "¿Vienen en pareja, en familia o con amigas? ¿Y para qué fecha?" },
            { role: "user", content: "en pareja, para el sábado 19 de diciembre" },
          ] as any,
          tools: schemas as any,
          temperature: 0.3,
        });
        const m2 = c2.choices[0]?.message;
        const llamadas = (m2?.tool_calls ?? []).map((x: any) => ({
          nombre: x.function?.name,
          args: x.function?.arguments,
        }));
        if (llamadas.length > 0) {
          llamoTrasResponder++;
          log(`   [turno 2 ok] llamó ${llamadas.map((l: any) => `${l.nombre}(${l.args})`).join(", ")}`);
          for (const l of llamadas) {
            if (!tools.some((t) => t.name === l.nombre)) problema(`el modelo llamó una herramienta INEXISTENTE: "${l.nombre}"`);
          }
        } else {
          const texto2 = (m2?.content ?? "").trim();
          problema(
            `con el grupo y la fecha ya dados ("${frase}" -> "en pareja, sábado 19 dic"), el modelo NO llamó la herramienta: ${JSON.stringify(texto2.slice(0, 160))}`
          );
        }
      } catch (e) {
        problema(`la prueba de dos turnos con "${frase}" falló: ${errTxt(e)}`);
      }
    }
  }

  log("");
  log(`  RESULTADO turno 1 (preguntar sin inventar precios): ${preguntoSinPrecios}/${total}`);
  log(`  RESULTADO turno 2 (llamar la herramienta con los datos): ${llamoTrasResponder}/${total}`);
  if (llamoTrasResponder === 0) problema("el modelo nunca llamó la herramienta ni con el grupo y la fecha dados");
  else if (llamoTrasResponder < total) aviso(`el modelo llamó la herramienta en ${llamoTrasResponder} de ${total}: comportamiento inconsistente`);
  else ok("con los datos dados, el modelo llamó la herramienta siempre");
}

// ============================================================================================
async function s6Orquestador(): Promise<void> {
  seccion("6. ORQUESTADOR — enrutamiento y pegajosidad");
  const casos: { mensaje: string; lastAgent: string | null; esperado: string }[] = [
    { mensaje: "Hola", lastAgent: null, esperado: "informacion" },
    { mensaje: "quiero conocer los planes y precios", lastAgent: null, esperado: "informacion|reservas" },
    { mensaje: "donde estan ubicados?", lastAgent: null, esperado: "informacion" },
    { mensaje: "tienen disponible el 20 de diciembre para 4 personas?", lastAgent: null, esperado: "reservas" },
    { mensaje: "como pago el anticipo?", lastAgent: "reservas", esperado: "pagos" },
    { mensaje: "necesito cambiar la fecha de mi reserva ya pagada", lastAgent: null, esperado: "postventa" },
    { mensaje: "quiero hablar con una persona real", lastAgent: null, esperado: "humano" },
    { mensaje: "somos 4", lastAgent: "reservas", esperado: "reservas (pegajosidad)" },
    { mensaje: "si", lastAgent: "pagos", esperado: "pagos (pegajosidad)" },
    { mensaje: "aceptan mascotas?", lastAgent: "reservas", esperado: "informacion" },
  ];
  for (const c of casos) {
    const t0 = Date.now();
    try {
      const d = await enrutarMensaje({ mensaje: c.mensaje, lastAgent: c.lastAgent });
      const marca = c.esperado.includes(d.agente) ? "ok " : "OJO";
      log(`   [${marca}] last_agent=${String(c.lastAgent)} | "${c.mensaje}"`);
      log(`          -> agente=${d.agente} (esperado: ${c.esperado}) motivo=${JSON.stringify(d.motivo)} (${ms(t0)})`);
      if (d.motivo === "fallback por error del orquestador") problema(`el orquestador cayó en fallback con "${c.mensaje}" — revisá el error de arriba en la consola`);
    } catch (e) {
      problema(`enrutarMensaje falló con "${c.mensaje}": ${errTxt(e)}`);
    }
  }
}

// ============================================================================================
async function s7Pipeline(): Promise<void> {
  seccion("7. PIPELINE COMPLETO (handleInbound) con adaptador falso — sin mandar WhatsApp");
  const recibidos: string[] = [];
  const fake: ChannelAdapter = {
    name: "diagnostico",
    async send(msg) {
      recibidos.push(msg.text ?? "");
    },
  };
  const externalId = `diag-${Date.now()}`;
  // Guion pensado para el flujo nuevo: la primera pregunta de precios NO debería traer
  // planes todavía, sino la pregunta de para cuántas personas es.
  const conversacion = [
    "Hola",
    "quiero conocer los planes y precios",
    "somos 2",
    "muestrame otros",
    "y otros mas?",
    "cuentame del plan paraiso",
    "a que hora es el check in?",
    "quiero reservar para el 20 de diciembre",
    "quiero hablar con una persona",
  ];
  for (const texto of conversacion) {
    const antes = recibidos.length;
    const t0 = Date.now();
    try {
      await handleInbound(
        { channel: "diagnostico", externalId, text: texto, timestamp: new Date().toISOString() },
        fake
      );
      const nuevas = recibidos.slice(antes);
      log("");
      log(`   CLIENTE: ${texto}`);
      if (nuevas.length === 0) problema(`el bot NO respondió nada a "${texto}"`);
      for (const r of nuevas) {
        log(`   BOT    : ${r}`);
        log(`   (largo: ${r.length} caracteres)`);
        if (r === "Perdón, no pude procesar eso. ¿Puedes repetirlo?") problema(`respuesta de FALLBACK a "${texto}" — algo falló internamente en ese turno`);
        if (r.length > LIMITE_WHATSAPP) {
          problema(`la respuesta a "${texto}" mide ${r.length} caracteres: pasa el límite de WhatsApp (${LIMITE_WHATSAPP})`);
        }
      }
      log(`   (${ms(t0)})`);
    } catch (e) {
      problema(`handleInbound lanzó excepción con "${texto}": ${errTxt(e)}`);
    }
  }

  try {
    const estado = await getEstado("diagnostico", externalId);
    log("");
    log(`  estado_conversacion guardado: ${JSON.stringify(estado)}`);
    if (estado.last_agent === null) problema("last_agent quedó en null tras toda la conversación: la pegajosidad del orquestador NO está funcionando (revisá si la tabla estado_conversacion existe)");
    else ok(`last_agent persistido = ${estado.last_agent}`);
    const guardados = await listMensajes("diagnostico", externalId);
    log(`  mensajes guardados en Supabase para esta conversación: ${guardados.length}`);
    if (guardados.length === 0) problema("no se guardó NINGÚN mensaje en la tabla `mensajes` (historial y monitor del panel quedan vacíos)");
  } catch (e) {
    problema(`verificación de estado/historial falló: ${errTxt(e)}`);
  }
}

// ============================================================================================
async function s8WhatsApp(): Promise<void> {
  seccion("8. CANAL WHATSAPP — firma del webhook, parseo y credenciales de YCloud");

  const secret = process.env.YCLOUD_WEBHOOK_SECRET;
  if (!secret) {
    problema("sin YCLOUD_WEBHOOK_SECRET no se puede validar ninguna firma: el webhook rechaza TODO con 401");
  } else {
    const payload = JSON.stringify({
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: {
        from: "573212191805",
        type: "text",
        text: { body: "prueba de diagnostico" },
        timestamp: new Date().toISOString(),
      },
    });
    const t = String(Math.floor(Date.now() / 1000));
    const firma = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

    const r1 = verifyYCloudSignature(`t=${t},s=${firma}`, Buffer.from(payload, "utf8"));
    r1.ok ? ok("firma válida aceptada correctamente") : problema(`firma válida RECHAZADA (${(r1 as any).reason})`);

    const r2 = verifyYCloudSignature(`t=${t},s=${"0".repeat(64)}`, Buffer.from(payload, "utf8"));
    !r2.ok ? ok(`firma falsa rechazada (${(r2 as any).reason})`) : problema("una firma FALSA fue aceptada");

    const viejo = String(Math.floor(Date.now() / 1000) - 3600);
    const firmaVieja = crypto.createHmac("sha256", secret).update(`${viejo}.${payload}`).digest("hex");
    const r3 = verifyYCloudSignature(`t=${viejo},s=${firmaVieja}`, Buffer.from(payload, "utf8"));
    !r3.ok ? ok(`webhook viejo rechazado (${(r3 as any).reason})`) : aviso("un webhook de hace 1 hora fue aceptado (¿WEBHOOK_FRESHNESS_SECONDS muy alto?)");

    try {
      const eventos = parseYcloudWebhook(Buffer.from(payload, "utf8"), `t=${t},s=${firma}`);
      log(`  parseYcloudWebhook devolvió ${eventos.length} evento(s): ${JSON.stringify(eventos.map((e) => ({ canal: e.channel, id: e.externalId, texto: e.text })))}`);
      if (eventos.length === 0) problema("el webhook se parseó pero NO produjo ningún evento: un mensaje real se descartaría en silencio");
      else if (eventos[0].externalId !== "+573212191805") problema(`el externalId quedó mal normalizado: ${eventos[0].externalId} (se esperaba +573212191805)`);
      else ok("el evento entrante se normalizó correctamente");
    } catch (e) {
      problema(`parseYcloudWebhook falló con un payload válido: ${errTxt(e)}`);
    }
  }

  const base = process.env.YCLOUD_BASE_URL ?? "https://api.ycloud.com";
  try {
    const t0 = Date.now();
    const res = await axios.get(`${base}/v2/whatsapp/phoneNumbers`, {
      headers: { "X-API-Key": process.env.YCLOUD_API_KEY ?? "" },
      timeout: 30_000,
    });
    ok(`credenciales de YCloud válidas (HTTP ${res.status}, ${ms(t0)})`);
    const items: any[] = res.data?.items ?? res.data?.data ?? [];
    const numeros = items.map((i) => i.phoneNumber ?? i.phone_number ?? i.id);
    log(`  números en la cuenta: ${JSON.stringify(numeros)}`);
    const from = process.env.YCLOUD_FROM_PHONE_NUMBER;
    if (from && numeros.length > 0 && !numeros.some((n) => String(n).replace(/\D/g, "") === from.replace(/\D/g, ""))) {
      problema(`YCLOUD_FROM_PHONE_NUMBER (${from}) no coincide con ningún número de la cuenta: los envíos van a fallar`);
    } else if (from) {
      ok(`YCLOUD_FROM_PHONE_NUMBER (${from}) corresponde a la cuenta`);
    }
  } catch (e) {
    problema(`no se pudo validar la cuenta de YCloud: ${errTxt(e)}`);
  }

  const arg = process.argv.find((a) => a.startsWith("--enviar-whatsapp="));
  if (arg) {
    const destino = arg.split("=")[1];
    log("");
    log(`  Enviando mensaje REAL de prueba a ${destino} (lo pediste con --enviar-whatsapp)...`);
    try {
      const t0 = Date.now();
      const r = await sendTextMessage(destino, "Prueba de diagnóstico del bot de La Julita — si recibiste esto, el envío por YCloud funciona.");
      ok(`envío aceptado por YCloud (${ms(t0)}): ${JSON.stringify(r).slice(0, 300)}`);
    } catch (e) {
      problema(`el envío real por YCloud FALLÓ: ${errTxt(e)}`);
    }
  } else {
    log("");
    log("  (no se mandó ningún mensaje real; usá --enviar-whatsapp=+57... si querés probar el envío)");
  }
}

// ============================================================================================
async function s9Cola(): Promise<void> {
  seccion("9. COLA REDIS / BULLMQ — estado y trabajos fallidos");
  try {
    const t0 = Date.now();
    const conn = getRedisConnection();
    const pong = await conn.ping();
    ok(`Redis responde ${pong} (${ms(t0)})`);
  } catch (e) {
    problema(`no se pudo conectar a Redis: ${errTxt(e)} — sin Redis el webhook encola al vacío y el cliente nunca recibe respuesta`);
    return;
  }
  try {
    const q = getInboundQueue();
    const counts = await q.getJobCounts();
    log(`  conteos de la cola 'inbound': ${JSON.stringify(counts)}`);
    if ((counts as any).failed > 0) problema(`hay ${(counts as any).failed} trabajo(s) FALLIDO(s) en la cola`);
    if ((counts as any).waiting > 0) aviso(`hay ${(counts as any).waiting} trabajo(s) esperando: ¿está corriendo el worker?`);

    const fallidos = await q.getFailed(0, 14);
    log(`  últimos ${fallidos.length} trabajo(s) fallido(s):`);
    for (const j of fallidos) {
      const d: any = j.data ?? {};
      log("");
      log(`   - job ${j.id} | intentos=${j.attemptsMade} | canal=${d.channel} | de=${d.externalId}`);
      log(`     mensaje del cliente: ${JSON.stringify(d.text)}`);
      log(`     error: ${String(j.failedReason).slice(0, 600)}`);
      const st = (j.stacktrace ?? [])[0];
      if (st) log(`     stack: ${String(st).split("\n").slice(0, 4).join(" | ")}`);
    }
    const completos = await q.getCompleted(0, 4);
    log("");
    log(`  últimos ${completos.length} trabajo(s) completado(s): ${JSON.stringify(completos.map((j) => ({ id: j.id, texto: (j.data as any)?.text })))}`);
  } catch (e) {
    problema(`no se pudo inspeccionar la cola: ${errTxt(e)}`);
  }
}


// ============================================================================================
async function s10Recontacto(): Promise<void> {
  seccion("10. RECONTACTO AUTOMÁTICO — horarios, cola y texto generado");

  log(`  habilitado (FOLLOWUP_ENABLED): ${RECONTACTO_HABILITADO}`);
  log(`  pasos de la cadena: ${PASOS_MS.map((ms) => `${Math.round(ms / 60000)} min`).join(" -> ")} (${MAX_PASOS} pasos)`);
  log(`  ventana nocturna: ${process.env.QUIET_HOURS_START_HOUR ?? 21}:00 a ${process.env.QUIET_HOURS_END_HOUR ?? 7}:00 (hora de Colombia)`);
  if (!RECONTACTO_HABILITADO) aviso("el recontacto está desactivado: FOLLOWUP_ENABLED=false");

  // Horario nocturno: funciones puras, se pueden probar con fechas fijas.
  const casos: [string, string, boolean][] = [
    ["martes 3:00 am Colombia", "2026-09-08T08:00:00Z", true],
    ["martes 10:00 am Colombia", "2026-09-08T15:00:00Z", false],
    ["martes 8:59 pm Colombia", "2026-09-09T01:59:00Z", false],
    ["martes 9:30 pm Colombia", "2026-09-09T02:30:00Z", true],
    ["martes 11:30 pm Colombia", "2026-09-09T04:30:00Z", true],
    ["miércoles 7:30 am Colombia", "2026-09-09T12:30:00Z", false],
  ];
  for (const [etiqueta, iso, esperado] of casos) {
    const ms = Date.parse(iso);
    const nocturno = esHorarioNocturno(ms);
    const corrido = ajustarPorHorarioNocturno(ms);
    const marca = nocturno === esperado ? "ok " : "OJO";
    const destino = new Date(corrido - 5 * 3600 * 1000).toISOString().slice(11, 16);
    log(`   [${marca}] ${etiqueta}: nocturno=${nocturno} (esperado ${esperado}) -> se manda ${nocturno ? `a las ${destino} Colombia` : "de inmediato"}`);
    if (nocturno !== esperado) problema(`la ventana nocturna clasificó mal ${etiqueta}`);
    if (nocturno && corrido <= ms) problema(`un recontacto nocturno (${etiqueta}) no se corrió a la mañana`);
  }

  // Cola de recontactos
  try {
    const q = getRecontactoQueue();
    const counts = await q.getJobCounts();
    log("");
    log(`  conteos de la cola 'recontacto': ${JSON.stringify(counts)}`);
    const pendientes = await q.getDelayed(0, 9);
    log(`  recontactos programados ahora mismo: ${pendientes.length}`);
    for (const j of pendientes) {
      const d: any = j.data ?? {};
      const cuando = j.opts?.delay != null && j.timestamp != null ? new Date(j.timestamp + j.opts.delay).toISOString() : "?";
      log(`   - ${d.canal}:${d.externalId} paso ${d.paso} -> ${cuando}`);
    }
    if ((counts as any).failed > 0) problema(`hay ${(counts as any).failed} recontacto(s) fallido(s) en la cola`);
  } catch (e) {
    problema(`no se pudo inspeccionar la cola de recontactos: ${errTxt(e)}`);
  }

  // Texto que generaría el recontacto (sin mandar nada a nadie)
  try {
    const prompt = fs.readFileSync(path.join(process.cwd(), "prompts", "recontacto.md"), "utf-8");
    const charla = [
      "Cliente: hola, quiero saber precios",
      "Bot: ¡Claro que sí! ¿Para cuántas personas sería?",
      "Cliente: para 2",
      "Bot: Para 2 personas te sirven estos: PLAN BASICO ... ¿Te muestro otros, o te cuento qué incluye alguno?",
    ].join("\n");
    for (const [etiqueta, extra] of [
      ["paso intermedio", "Este es un recontacto intermedio: liviano y casual, sin presión."],
      ["último paso", "Este es el ÚLTIMO recontacto de la cadena: podés darle un toque más de urgencia, sin inventar fechas límite y sin presionar feo."],
    ] as [string, string][]) {
      const t0 = Date.now();
      const c = await openrouter.chat.completions.create({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: prompt },
          { role: "system", content: extra },
          { role: "user", content: charla },
        ] as any,
        temperature: 0.6,
      });
      const texto = (c.choices[0]?.message?.content ?? "").trim();
      log("");
      log(`  --- texto de recontacto (${etiqueta}, ${ms(t0)}, ${texto.length} caracteres) ---`);
      log(`  ${texto}`);
      if (!texto) problema(`el recontacto (${etiqueta}) generó texto vacío`);
      if (texto.length > 400) aviso(`el recontacto (${etiqueta}) salió largo (${texto.length} caracteres): debería ser 1-2 frases`);
      if (texto.includes("**")) problema(`el recontacto (${etiqueta}) usó ** (WhatsApp no lo interpreta)`);
    }
  } catch (e) {
    problema(`no se pudo generar el texto de recontacto: ${errTxt(e)}`);
  }
}

// ============================================================================================
async function s11Reserva(): Promise<void> {
  seccion("11. REGISTRO DE DATOS DE RESERVA (clientes + acompanantes + reservas)");

  // Catálogos obligatorios: sin ellos la herramienta no puede escribir nada.
  //
  // [2026-09-09] `estado` solo hace falta si el bot CREA la reserva (reservas.estado_id es
  // NOT NULL). Con CREAR_RESERVA_DESDE_BOT=false — el modo que pidió el equipo — el bot solo
  // escribe en `clientes` y `acompanantes`, así que una tabla `estado` vacía no rompe nada:
  // reportarlo como problema era una falsa alarma de este script.
  const creaReservas = (process.env.CREAR_RESERVA_DESDE_BOT ?? "false").toLowerCase() === "true";
  log(`  CREAR_RESERVA_DESDE_BOT: ${creaReservas ? "true (el bot crea la reserva)" : "false (solo cliente + acompañantes)"}`);
  const catalogos: [string, string, boolean][] = [
    ["tipo_documento", "clientes.tipo_documento_id y acompanantes.tipo_documento_id son NOT NULL", true],
    ["estado", "reservas.estado_id es NOT NULL", creaReservas],
  ];
  for (const [tabla, pista, obligatoria] of catalogos) {
    const { count, error } = await supabase.from(tabla).select("*", { count: "exact", head: true });
    if (error) problema(`no pude leer ${tabla}: ${error.message}`);
    else if (count) ok(`${tabla}: ${count} fila(s)`);
    else if (obligatoria) problema(`la tabla ${tabla} está VACÍA y ${pista}: corré sql/reserva-datos-cliente.sql`);
    else log(`  ${tabla}: vacía — no hace falta mientras CREAR_RESERVA_DESDE_BOT=false (${pista})`);
  }

  const idCedula = await resolverTipoDocumento("cédula");
  const idPasaporte = await resolverTipoDocumento("pasaporte");
  log(`  resolverTipoDocumento("cédula") -> ${idCedula}   resolverTipoDocumento("pasaporte") -> ${idPasaporte}`);
  if (idCedula == null) aviso("no se pudo resolver 'cédula' a un tipo de documento (¿falta el seed?)");

  // Validaciones: estos casos NO escriben en la base, solo verifican qué pide.
  const ctx = { channel: "diagnostico", externalId: "diag" };
  const casos: [string, Record<string, unknown>][] = [
    ["sin nada", {}],
    ["sin fecha", { plan: "paraiso", personas: 2, cliente: { nombre: "Ana Ruiz", tipo_documento: "CC", numero_documento: "123", celular: "3001234567" } }],
    ["sin celular de quien reserva", { plan: "paraiso", fecha: "2026-12-19", personas: 1, cliente: { nombre: "Ana Ruiz", tipo_documento: "CC", numero_documento: "123" } }],
    [
      "2 personas pero solo datos de 1",
      { plan: "paraiso", fecha: "2026-12-19", personas: 2, cliente: { nombre: "Ana Ruiz", tipo_documento: "CC", numero_documento: "123", celular: "3001234567" } },
    ],
    [
      "acompañante sin documento",
      {
        plan: "paraiso", fecha: "2026-12-19", personas: 2,
        cliente: { nombre: "Ana Ruiz", tipo_documento: "CC", numero_documento: "123", celular: "3001234567" },
        acompanantes: [{ nombre: "Luis Pérez" }],
      },
    ],
    [
      "plan que no existe",
      {
        plan: "plan que no existe", fecha: "2026-12-19", personas: 1,
        cliente: { nombre: "Ana Ruiz", tipo_documento: "CC", numero_documento: "123", celular: "3001234567" },
      },
    ],
  ];

  for (const [etiqueta, argumentos] of casos) {
    try {
      const r = await registrarDatosReservaTool.handler(argumentos, ctx);
      const okEsperado = (r.result as any)?.ok === false;
      log("");
      log(`   > ${etiqueta} -> ${okEsperado ? "pide lo que falta (ok)" : "OJO: no rechazó"}`);
      log(`     ${r.reply_to_user}`);
      if (!okEsperado) problema(`registrar_datos_reserva aceptó un caso incompleto: ${etiqueta}`);
    } catch (e) {
      problema(`registrar_datos_reserva lanzó excepción en "${etiqueta}": ${errTxt(e)}`);
    }
  }

  // Registro real, solo si se pide explícitamente (escribe filas de prueba en la base).
  if (process.argv.includes("--registrar-prueba")) {
    log("");
    log("  Registrando una reserva de PRUEBA en la base (lo pediste con --registrar-prueba)...");
    try {
      const r = await registrarDatosReservaTool.handler(
        {
          plan: "paraiso",
          fecha: "2026-12-19",
          personas: 2,
          cliente: { nombre: "PRUEBA Diagnostico", tipo_documento: "CC", numero_documento: `999${Date.now() % 100000}`, celular: "3000000000" },
          acompanantes: [{ nombre: "PRUEBA Acompanante", tipo_documento: "CC", numero_documento: `888${Date.now() % 100000}` }],
        },
        ctx
      );
      log(`     resultado: ${JSON.stringify(r.result)}`);
      log(`     mensaje: ${r.reply_to_user}`);
      if ((r.result as any)?.ok) ok("la reserva de prueba quedó registrada (acordate de borrarla de la base)");
      else problema(`no se pudo registrar la reserva de prueba: ${(r.result as any)?.motivo}`);
      // [2026-09-09] Con la reserva registrada, registrar_datos_reserva también intenta crear
      // un bloqueo temporal de 10 minutos — se ve reflejado en el propio mensaje al cliente.
      if ((r.result as any)?.ok) {
        if (/⏳.*minutos/i.test(r.reply_to_user ?? "")) ok("el registro de prueba también armó el bloqueo temporal (avisó los minutos al cliente)");
        else aviso("el registro de prueba NO mostró el aviso de bloqueo temporal — revisar reserva.ts (¿la clase del plan se reconoció?)");
      }
    } catch (e) {
      problema(`el registro de prueba lanzó excepción: ${errTxt(e)}`);
    }
  } else {
    log("");
    log("  (no se escribió nada en la base; usá --registrar-prueba si querés probar el registro real)");
  }
}

// ============================================================================================
async function s12Correcciones(): Promise<void> {
  seccion("12. APRENDIZAJE ASISTIDO — identificación del equipo y correcciones");

  const autorizados = numerosAutorizados();
  const codigo = (process.env.TEAM_SECRET_CODE ?? "").trim();
  const usuariosCrudos = (process.env.TEAM_LOGIN_USERS ?? "").split(",").filter((x) => x.includes(":"));

  log(`  números con atajo (OWNER_WHATSAPP_NUMBERS): ${autorizados.length > 0 ? autorizados.join(", ") : "(ninguno)"}`);
  log(`  código secreto (TEAM_SECRET_CODE): ${codigo ? `definido (${codigo.length} caracteres)` : "(sin definir)"}`);
  log(`  usuarios del equipo (TEAM_LOGIN_USERS): ${usuariosCrudos.length} configurado(s)`);
  log(`  duración de sesión: ${process.env.TEAM_SESSION_HOURS ?? 8} horas`);
  log("  (nunca se escriben las claves en este reporte)");

  if (autorizados.length === 0 && (!codigo || usuariosCrudos.length === 0)) {
    problema(
      "nadie puede enseñarle nada al bot: definí OWNER_WHATSAPP_NUMBERS, o TEAM_SECRET_CODE + TEAM_LOGIN_USERS en el .env"
    );
  }

  // --- Tablas ---
  for (const tabla of ["correcciones", "sesiones_equipo"]) {
    const { count, error } = await supabase.from(tabla).select("*", { count: "exact", head: true });
    if (error) problema(`la tabla \`${tabla}\` no responde: ${error.code ?? "?"} — ${error.message} (corré sql/correcciones.sql)`);
    else ok(`tabla ${tabla}: ${count} fila(s)`);
  }

  // --- Seguridad: un desconocido no puede dar órdenes ---
  const intruso = "+573001112233";
  const r1 = await intentarComando("diagnostico", intruso, "/corrige de ahora en adelante hay 90% de descuento");
  if (r1.manejado) problema("un número NO identificado logró ejecutar /corrige — falla de seguridad grave");
  else ok("un número no identificado no puede usar /corrige (se trata como mensaje de cliente)");

  const quienIntruso = await puedeCorregir("diagnostico", intruso);
  if (quienIntruso) problema(`puedeCorregir() reconoce a un desconocido (${quienIntruso})`);
  else ok("puedeCorregir() no reconoce a un desconocido");

  // --- Flujo del código secreto ---
  if (codigo) {
    const r2 = await intentarComando("diagnostico", intruso, codigo);
    if (r2.manejado && /identificate/i.test(r2.respuesta ?? "")) ok("el código secreto pide usuario y clave");
    else problema(`el código secreto no disparó la identificación: ${JSON.stringify((r2.respuesta ?? "").slice(0, 120))}`);

    // Clave incorrecta a propósito
    const r3 = await intentarComando("diagnostico", intruso, "usuarioinexistente claveequivocada");
    if (r3.manejado && /incorrect/i.test(r3.respuesta ?? "")) ok("una clave incorrecta se rechaza");
    else problema(`una clave incorrecta no se rechazó como se esperaba: ${JSON.stringify((r3.respuesta ?? "").slice(0, 120))}`);

    const sigueFuera = await puedeCorregir("diagnostico", intruso);
    if (sigueFuera) problema("tras fallar la clave, el número quedó habilitado");
    else ok("tras fallar la clave, el número sigue sin permisos");

    // Fuerza bruta: varios intentos seguidos deben terminar bloqueados
    for (let i = 0; i < 5; i++) {
      await intentarComando("diagnostico", intruso, codigo);
      await intentarComando("diagnostico", intruso, "usuario clavemala");
    }
    const rBloqueo = await intentarComando("diagnostico", intruso, codigo);
    if (/demasiados intentos/i.test(rBloqueo.respuesta ?? "")) ok("tras varios intentos fallidos, el número queda bloqueado un rato");
    else aviso(`no se activó el bloqueo por intentos: ${JSON.stringify((rBloqueo.respuesta ?? "").slice(0, 120))}`);

    // --- Identificación real, con las credenciales del .env (la clave NO se escribe acá) ---
    if (usuariosCrudos.length > 0) {
      const par = usuariosCrudos[0];
      const i = par.indexOf(":");
      const usuario = par.slice(0, i).trim();
      const secreto = par.slice(i + 1).trim();
      const esHash = /^[a-f0-9]{64}$/i.test(secreto);
      const numeroPrueba = "+573009998877";

      if (esHash) {
        aviso(
          `la clave de "${usuario}" está guardada como hash (bien), así que este reporte no puede probar la ` +
            "identificación completa: probala por WhatsApp mandando el código secreto"
        );
      } else {
        await intentarComando("diagnostico", numeroPrueba, codigo);
        const r4 = await intentarComando("diagnostico", numeroPrueba, `${usuario} ${secreto}`);
        const identificado = /quedaste identificado/i.test(r4.respuesta ?? "");
        identificado ? ok(`la identificación de "${usuario}" funciona (clave correcta aceptada)`) : problema("la identificación con la clave del .env NO funcionó");

        if (identificado) {
          const quien = await puedeCorregir("diagnostico", numeroPrueba);
          quien ? ok(`el número identificado ya puede corregir (usuario: ${quien})`) : problema("tras identificarse, el número no puede corregir");
          await cerrarSesion("diagnostico", numeroPrueba);
          const despues = await puedeCorregir("diagnostico", numeroPrueba);
          despues ? problema("la sesión no se cerró") : ok("la sesión se cierra correctamente");
        }
      }
    }
  }

  // --- Lo aprendido y el bloque que se le inyecta al modelo ---
  const activas = await listCorrecciones(true);
  log("");
  log(`  correcciones activas: ${activas.length}`);
  for (const c of activas) log(`   - #${c.id} (${c.autor}) ${c.texto}`);

  const bloque = await bloqueDeCorrecciones();
  log(`  bloque inyectado al prompt: ${bloque ? `${bloque.length} caracteres` : "(ninguno, no hay correcciones)"}`);
  if (bloque) log(`  ${bloque.replace(/\n/g, "\n  ")}`);

  if (process.argv.includes("--registrar-prueba")) {
    log("");
    log("  Probando /corrige de punta a punta...");
    const numero = autorizados[0] ?? "+573009998877";
    if (!autorizados[0]) await intentarComando("diagnostico", numero, codigo);
    const texto = `PRUEBA de diagnóstico ${new Date().toISOString()} — ignorá esta corrección`;
    const r = await intentarComando("diagnostico", numero, `/corrige ${texto}`);
    log(`     respuesta: ${r.respuesta}`);
    const despues = await listCorrecciones(true);
    const creada = despues.find((c) => c.texto === texto);
    if (!creada?.id) problema("el comando /corrige no dejó la corrección en la base");
    else {
      ok(`la corrección quedó guardada (#${creada.id})`);
      const quitada = await desactivarCorreccion(creada.id);
      quitada ? ok("y se pudo desactivar (queda en el historial, inactiva)") : problema("no se pudo desactivar la corrección de prueba");
    }
  } else {
    log("");
    log("  (no se escribió ninguna corrección; usá --registrar-prueba para la prueba completa)");
  }
}

async function s13LobbyPMS(): Promise<void> {
  seccion("13. DISPONIBILIDAD REAL (LobbyPMS) — API oficial + motor público de respaldo");
  log(
    "  [2026-09-10] Ahora hay DOS vías: la API OFICIAL (api.lobbypms.com/api/v1, con token y con " +
      "restricción de IP, que da el cupo DÍA POR DÍA) y, como respaldo automático, el motor " +
      "público de siempre. Si la oficial falla, el bot no se rompe: sigue con el respaldo, pero " +
      "pierde el detalle por día (o sea, no puede ofrecer fechas alternativas). Para probar la " +
      "API oficial a fondo: npx tsx scripts/probar-lobbypms.ts"
  );
  log(`  LOBBYPMS_API_TOKEN configurado: ${apiOficialConfigurada() ? "sí" : "NO"}`);
  log(
    "  [2026-09-09] consultar_planes cruza el cupo real del motor de reservas " +
      "(engine.lobbypms.com/la-julita-glamping) cuando le pasás fecha + nivel/plan. No es una " +
      "API oficial documentada — es el endpoint interno que usa el widget público, confirmado " +
      "sin necesitar login. Si LobbyPMS cambia ese endpoint, esta sección es la que se rompe " +
      "primero (y el bot cae solo al 'le confirmo con el equipo' de siempre — no se rompe la " +
      "cotización, solo se pierde el dato de cupo)."
  );

  const fecha = "2026-12-19"; // sábado, bien a futuro para no chocar con nada real
  const t0 = Date.now();
  const disponibilidad = await consultarDisponibilidad(fecha, 1);
  const ms = Date.now() - t0;

  if (!disponibilidad) {
    problema(
      `consultarDisponibilidad(${fecha}) devolvió null: no se pudo confirmar cupo real — revisá ` +
        "la red o si LobbyPMS cambió el endpoint (ver src/core/integrations/lobbypms.ts). El bot " +
        "sigue funcionando, solo deja de decir sí/no de cupo y vuelve al 'le confirmo con el equipo'."
    );
  } else {
    ok(`consultarDisponibilidad(${fecha}) respondió en ${ms}ms con ${disponibilidad.length} categoría(s)`);
    for (const d of disponibilidad) {
      log(`   - ${d.nombreLobby} (clase=${d.clase}, capacidad=${d.capacidad}): ${d.disponibles} disponible(s)`);
    }
    const clasesEsperadas = ["chalet", "deluxe", "clasico"];
    const faltantes = clasesEsperadas.filter((c) => !disponibilidad.some((d) => d.clase === c));
    if (faltantes.length > 0) {
      aviso(`no llegó ninguna categoría de LobbyPMS para: ${faltantes.join(", ")} — revisar CATEGORIAS_LOBBY`);
    }
    const clasicoRomantic = disponibilidad.find((d) => d.clase === "clasico" && d.capacidad === 2);
    const clasicoFamiliar = disponibilidad.find((d) => d.clase === "clasico" && d.capacidad === 4);
    if (!clasicoRomantic || !clasicoFamiliar) {
      problema(
        "LobbyPMS no separó 'clasico' en romantic(2p)/familiar(4p) como se esperaba — revisar el " +
          "mapeo CATEGORIAS_LOBBY en src/core/integrations/lobbypms.ts"
      );
    }
  }

  // --- ¿Por qué vía salió el dato? (API oficial vs. respaldo) ---
  log("");
  const porDia = await consultarDisponibilidadPorDia(fecha, 1);
  const estadoOficial = estadoUltimaConsultaOficial();
  if (porDia) {
    ok(`la API OFICIAL respondió con detalle por día (${porDia.length} día/s) — es la vía preferida`);
  } else if (estadoOficial === "ip_no_autorizada") {
    aviso(
      "la API oficial rechazó la IP de este servidor: hay que autorizarla en LobbyPMS " +
        "(Configuraciones -> API -> restricciones de IP). El bot está usando el motor público de " +
        "respaldo, así que NO puede ofrecer fechas alternativas todavía."
    );
  } else if (estadoOficial === "sin_token") {
    aviso("falta LOBBYPMS_API_TOKEN en el .env: el bot usa solo el motor público (sin fechas alternativas).");
  } else if (estadoOficial === "token_invalido") {
    problema("LOBBYPMS_API_TOKEN inválido o rotado — revisar el token en el panel de LobbyPMS.");
  } else {
    aviso(`la API oficial no respondió (${estadoOficial ?? "sin datos"}); el bot sigue con el motor público.`);
  }

  // --- Fechas alternativas: lo que el bot ofrece cuando la fecha pedida está llena ---
  log("");
  log("  --- consultar_fechas_alternativas (solo funciona con la API oficial) ---");
  try {
    const alternativas = await buscarFechasAlternativas(fecha, 1, 7);
    if (!alternativas) {
      log("   buscarFechasAlternativas devolvió null (sin API oficial) — el bot NO inventa fechas: dice que confirma con el equipo");
    } else {
      log(`   ${alternativas.length} fecha(s) con cupo entre ${fecha} y los 7 días siguientes`);
      for (const alt of alternativas.slice(0, 8)) {
        log(`    - ${alt.fecha}: ${alt.categorias.map((x) => `${x.nombreLobby} (${x.disponibles})`).join(", ")}`);
      }
    }
    const rTool = await consultarFechasAlternativasTool.handler(
      { fecha, noches: 1, personas: 2 },
      { channel: "diagnostico", externalId: "diag" }
    );
    log("");
    log(`   > respuesta de la herramienta al cliente:`);
    log(`     ${(rTool.reply_to_user ?? "").replace(/\n/g, "\n     ")}`);
  } catch (e) {
    problema(`consultar_fechas_alternativas lanzó excepción: ${errTxt(e)}`);
  }

  // --- Con esto conectado, ¿consultar_planes muestra el cupo en una cotización real? ---
  log("");
  log("  --- consultar_planes con fecha + nivel (debe traer cupo real si LobbyPMS respondió) ---");
  const ctx = { channel: "diagnostico", externalId: "diag" };
  const casosCupo: [string, Record<string, unknown>][] = [
    ["pareja, nivel=por_noche, con fecha", { segmento: "pareja", personas: 2, fecha, nivel: "por_noche" }],
    ["familia, nivel=intermedio, con fecha", { segmento: "familia", personas: 4, fecha, nivel: "intermedio" }],
    ["plan='paraiso' con fecha (detalle)", { plan: "paraiso", fecha }],
  ];
  for (const [etiqueta, argumentos] of casosCupo) {
    try {
      const r = await consultarPlanesTool.handler(argumentos, ctx);
      const texto = r.reply_to_user ?? "";
      const trajoCupo = /cupo: sí|sin cupo esa fecha|SÍ tengo cupo|no me queda cupo/.test(texto);
      log("");
      log(`   > ${etiqueta} — ¿trajo dato de cupo?: ${trajoCupo ? "sí" : "no"}`);
      log(`     ${texto.replace(/\n/g, "\n     ")}`);
      if (disponibilidad && !trajoCupo) {
        aviso(`consultar_planes(${etiqueta}) no mostró cupo aunque LobbyPMS sí respondió — revisar cupoParaPlan/clasesDePlan`);
      }
    } catch (e) {
      problema(`consultar_planes(${etiqueta}) lanzó excepción probando cupo: ${errTxt(e)}`);
    }
  }
}

async function s14Bloqueos(): Promise<void> {
  seccion("14. BLOQUEO TEMPORAL DE CUPO (10 min) — creación, conteo, confirmar, liberar");
  log(
    "  [2026-09-09] Prueba el candado interno del bot (sql/bloqueos-temporales.sql) SIN esperar " +
      "los 10 minutos reales: crea un bloqueo con vigencia de 0 minutos (ya nace vencido) para " +
      "poder probar la liberación al toque."
  );

  if (!process.argv.includes("--registrar-prueba")) {
    log("");
    log("  (no se escribió nada en la base; usá --registrar-prueba si querés probar el ciclo completo)");
    const pendientes = await bloqueosPendientes("diagnostico");
    log(`  bloqueos pendientes ahora mismo en canal 'diagnostico': ${pendientes.length}`);
    return;
  }

  const canal = "diagnostico";
  const externalId = `diag-bloqueo-${Date.now()}`;
  const otroExternalId = `diag-bloqueo-otro-${Date.now()}`;
  const fecha = "2026-12-19";

  // --- 1. Crear un bloqueo y que YA reste del cupo para OTRA conversación ---
  const b1 = await crearBloqueo({
    canal,
    externalId,
    planId: null,
    claseDomo: "deluxe",
    capacidad: 2,
    fechaEntrada: fecha,
    minutosVigencia: 10,
  });
  if (!b1) {
    problema("crearBloqueo devolvió null — revisar que exista la tabla bloqueos_temporales (sql/bloqueos-temporales.sql)");
    return;
  }
  ok(`bloqueo #${b1.id} creado (expira ${b1.expira_en})`);

  const paraOtro = await contarBloqueosActivos("deluxe", 2, fecha, { canal, externalId: otroExternalId });
  const paraElMismo = await contarBloqueosActivos("deluxe", 2, fecha, { canal, externalId });
  log(`  contarBloqueosActivos para OTRA conversación: ${paraOtro} (esperado: al menos 1)`);
  log(`  contarBloqueosActivos para LA MISMA conversación (excluida): ${paraElMismo} (esperado: 0, no se cuenta a sí mismo)`);
  if (paraOtro < 1) problema("contarBloqueosActivos no le restó el cupo a una conversación distinta — el candado no protege nada");
  if (paraElMismo !== 0) problema("contarBloqueosActivos SÍ le restó su propio bloqueo a la misma conversación (no debería)");

  // --- 2. Confirmar (como haría el equipo con /confirmar) y verificar que ya NO se libera ---
  const confirmado = await confirmarBloqueo(b1.id);
  ok(`confirmarBloqueo(#${b1.id}): ${confirmado ? "ok" : "falló"}`);
  const liberadoTrasConfirmar = await liberarBloqueoSiVencido(b1.id);
  if (liberadoTrasConfirmar) {
    problema(`liberarBloqueoSiVencido liberó el bloqueo #${b1.id} DESPUÉS de confirmado — un cliente que ya pagó se quedaría sin cupo igual`);
  } else {
    ok("un bloqueo ya confirmado NO se libera aunque el worker lo intente (protegido)");
  }

  // --- 3. Un segundo bloqueo que SÍ vence (vigencia 0) y se libera solo ---
  const b2 = await crearBloqueo({
    canal,
    externalId: otroExternalId,
    planId: null,
    claseDomo: "chalet",
    capacidad: 2,
    fechaEntrada: fecha,
    minutosVigencia: 0,
  });
  if (!b2) {
    problema("no se pudo crear el segundo bloqueo de prueba (vigencia 0)");
  } else {
    const liberado = await liberarBloqueoSiVencido(b2.id);
    if (liberado && liberado.estado === "liberado") {
      ok(`bloqueo #${b2.id} (vigencia 0 min) se liberó correctamente`);
    } else {
      problema(`bloqueo #${b2.id} debía liberarse (ya venció) y no se liberó`);
    }
    const segundaLiberacion = await liberarBloqueoSiVencido(b2.id);
    if (segundaLiberacion) {
      problema(`liberarBloqueoSiVencido volvió a "liberar" el bloqueo #${b2.id} una segunda vez — mandaría el aviso al cliente dos veces`);
    } else {
      ok("liberar un bloqueo ya liberado no hace nada (no se duplica el aviso al cliente)");
    }
  }

  log("");
  log(`  (quedaron bloqueos de PRUEBA en la base: #${b1.id}${b2 ? `, #${b2.id}` : ""} — se pueden borrar a mano, la tabla es de vida corta)`);
}

// ============================================================================================
async function s15Postventa(): Promise<void> {
  seccion("15. AGENTE DE POSTVENTA — buscar_reserva_cliente + toolset propio");
  log(
    "  [2026-09-10] postventa ya tiene prompt y herramientas propias (ver " +
      "src/agentes/postventa/prompt.md y src/agentes/postventa/agente.ts). Esta " +
      "sección NO prueba el prompt (eso lo hace la sección 5, con el modelo real) — prueba que " +
      "la herramienta buscar_reserva_cliente consulta bien la tabla `reservas`, que sigue siendo " +
      "la única fuente de verdad (una reserva puede haberse hecho fuera del bot, vía LobbyPMS)."
  );

  const nombresEsperados = ["buscar_reserva_cliente", "consultar_planes", "consultar_adicionales", "registrar_datos_reserva"];
  const herramientasPostventa = await herramientasDe("postventa");
  const nombresReales = herramientasPostventa.map((t) => t.name);
  const faltan = nombresEsperados.filter((n) => !nombresReales.includes(n));
  if (faltan.length > 0) {
    problema(`el agente de postventa no tiene: ${faltan.join(", ")}`);
  } else {
    ok(`el agente de postventa trae las herramientas esperadas: ${nombresReales.join(", ")}`);
  }

  const { count: totalReservas } = await supabase.from("reservas").select("*", { count: "exact", head: true });
  const { count: totalEstados } = await supabase.from("estado").select("*", { count: "exact", head: true });
  log(`  filas en \`reservas\`: ${totalReservas ?? 0} — filas en \`estado\`: ${totalEstados ?? 0}`);
  if (!totalEstados) {
    aviso(
      "la tabla `estado` está vacía: buscar_reserva_cliente NUNCA va a encontrar una reserva " +
        "'confirmada' hasta que existan filas en `estado` con una que contenga 'confirmad' y " +
        "reservas con ese estado_id (ver sql/reserva-datos-cliente.sql y la nota de runTurn/postventa)."
    );
  }

  // --- Búsqueda directa a la tabla, con un celular que casi seguro no existe ---
  const celularDePrueba = "3009999999";
  const directo = await buscarReservasConfirmadasPorCelular(celularDePrueba);
  log(`  buscarReservasConfirmadasPorCelular("${celularDePrueba}") -> ${directo.length} reserva(s)`);

  // --- La herramienta tal como la llamaría el modelo, con el número como externalId ---
  const ctx = { channel: "diagnostico", externalId: `whatsapp:+57${celularDePrueba}` };
  try {
    const r = await buscarReservaClienteTool.handler({}, ctx);
    log("");
    log("   > buscar_reserva_cliente con un número sin reservas (esperado: invita a aclarar, no deja sin respuesta)");
    log(`     ${(r.reply_to_user ?? "").replace(/\n/g, "\n     ")}`);
    if (!r.reply_to_user) {
      problema("buscar_reserva_cliente no devolvió reply_to_user para el caso sin reservas");
    }
  } catch (e) {
    problema(`buscar_reserva_cliente lanzó excepción: ${errTxt(e)}`);
  }

  // --- Si hay AL MENOS una reserva confirmada real en la base, probá con su cliente también ---
  if ((totalReservas ?? 0) > 0 && (totalEstados ?? 0) > 0) {
    const { data: algunaConfirmada } = await supabase
      .from("reservas")
      .select("clientes(celular)")
      .limit(50);
    const celularReal = (algunaConfirmada as any[] | null)?.find((r) => r?.clientes?.celular)?.clientes?.celular;
    if (celularReal) {
      const reales = await buscarReservasConfirmadasPorCelular(celularReal);
      log("");
      log(`  con un celular real de la base (${celularReal}): ${reales.length} reserva(s) confirmada(s) encontrada(s)`);
    }
  }
}

// ============================================================================================
async function main(): Promise<void> {
  log(`REPORTE DE DIAGNÓSTICO — bot La Julita`);
  log(`fecha: ${new Date().toISOString()}`);
  log(`archivo: ${REPORTE}`);

  const etapas: [string, () => Promise<void>][] = [
    ["configuración", s1Configuracion],
    ["supabase/tablas", s2Supabase],
    ["supabase/datos", s3Datos],
    ["herramientas", s4Herramientas],
    ["modelo", s5Modelo],
    ["orquestador", s6Orquestador],
    ["pipeline", s7Pipeline],
    ["whatsapp", s8WhatsApp],
    ["cola", s9Cola],
    ["recontacto", s10Recontacto],
    ["reserva", s11Reserva],
    ["correcciones", s12Correcciones],
    ["lobbypms", s13LobbyPMS],
    ["bloqueos", s14Bloqueos],
    ["postventa", s15Postventa],
  ];
  for (const [nombre, fn] of etapas) {
    try {
      await fn();
    } catch (e) {
      problema(`la etapa "${nombre}" se cayó por completo: ${errTxt(e)}`);
    }
  }

  seccion("RESUMEN");
  log(`  problemas encontrados: ${problemas.length}`);
  problemas.forEach((p, i) => log(`   ${i + 1}. ${p}`));
  log("");
  log(`  avisos: ${avisos.length}`);
  avisos.forEach((a, i) => log(`   ${i + 1}. ${a}`));
  log("");
  log(`Reporte guardado en: ${REPORTE}`);

  try {
    await getInboundQueue().close();
  } catch {}
  try {
    await getRecontactoQueue().close();
  } catch {}
  try {
    getRedisConnection().disconnect();
  } catch {}
  process.exit(0);
}

main();
