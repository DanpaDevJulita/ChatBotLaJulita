/**
 * Prueba de la API oficial de LobbyPMS (api.lobbypms.com/api/v1) — creado el 2026-09-10.
 *
 * Para qué sirve: la API oficial exige, además del token, que la IP de salida esté autorizada
 * en el panel de LobbyPMS. Este script dice con precisión en qué estado está la conexión y, si
 * funciona, trae la FORMA REAL de los datos de cada endpoint — eso es lo que hace falta para
 * construir la sincronización de reservas y el bloqueo real de cupo.
 *
 *   npx tsx scripts/probar-lobbypms.ts
 *   npx tsx scripts/probar-lobbypms.ts --fecha=2026-12-19 --noches=2
 *
 * SOLO hace peticiones de LECTURA (GET). No crea, modifica ni bloquea nada en LobbyPMS.
 *
 * Sobre datos personales: de `bookings` e `invoices` imprime únicamente los NOMBRES DE LOS
 * CAMPOS y el conteo, nunca los valores — esas tablas traen nombres, documentos y teléfonos de
 * huéspedes reales y este reporte se comparte.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import {
  consultarDisponibilidadPorDia,
  consultarMotorPublico,
  consultarDisponibilidad,
  buscarFechasAlternativas,
  estadoUltimaConsultaOficial,
  apiOficialConfigurada,
  sumarDias,
} from "../src/core/integrations/lobbypms.js";

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const REPORTE = path.join(process.cwd(), `lobbypms-prueba-${stamp}.txt`);

function log(...partes: unknown[]): void {
  const linea = partes.map((p) => (typeof p === "string" ? p : JSON.stringify(p, null, 2))).join(" ");
  console.log(linea);
  fs.appendFileSync(REPORTE, linea + "\n", "utf-8");
}

function titulo(t: string): void {
  log("");
  log("=".repeat(88));
  log(`== ${t}`);
  log("=".repeat(88));
}

function arg(nombre: string): string | undefined {
  const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.split("=")[1] : undefined;
}

const API_URL = (process.env.LOBBYPMS_API_URL ?? "https://api.lobbypms.com/api/v1").replace(/\/+$/, "");
const TOKEN = (process.env.LOBBYPMS_API_TOKEN ?? "").trim();

const FECHA = arg("fecha") ?? sumarDias(new Date().toISOString().slice(0, 10), 30)!;
const NOCHES = Number(arg("noches") ?? 1);

/** Petición cruda, para poder mostrar el status y el cuerpo exactos que devuelve LobbyPMS. */
async function crudo(
  ruta: string,
  params: Record<string, string | number> = {}
): Promise<{ status: number; data: unknown }> {
  try {
    const res = await axios.get(`${API_URL}/${ruta}`, {
      params: { api_token: TOKEN, ...params },
      timeout: 15_000,
      headers: { Accept: "application/json" },
      validateStatus: () => true,
    });
    return { status: res.status, data: res.data };
  } catch (err) {
    const status = (err as any)?.response?.status ?? 0;
    const data = (err as any)?.response?.data ?? String((err as any)?.message ?? err);
    return { status, data };
  }
}

/** Nombres de los campos de una respuesta, sin exponer valores (para datos de huéspedes). */
function camposDe(data: unknown): string[] {
  const filas = Array.isArray(data) ? data : (data as any)?.data;
  const primera = Array.isArray(filas) ? filas[0] : filas;
  if (!primera || typeof primera !== "object") return [];
  return Object.keys(primera as Record<string, unknown>);
}

function cuantas(data: unknown): number | string {
  const filas = Array.isArray(data) ? data : (data as any)?.data;
  return Array.isArray(filas) ? filas.length : "(no es un arreglo)";
}

async function main(): Promise<void> {
  log("PRUEBA DE LA API OFICIAL DE LOBBYPMS");
  log(`fecha de la prueba: ${new Date().toISOString()}`);
  log(`fecha consultada: ${FECHA} — noches: ${NOCHES}`);
  log(`archivo: ${REPORTE}`);

  // ---------------------------------------------------------------------------------------
  titulo("1. CONFIGURACIÓN");
  log(`  LOBBYPMS_API_URL: ${API_URL}`);
  if (!apiOficialConfigurada()) {
    log("  [PROBLEMA] LOBBYPMS_API_TOKEN no está configurado en el .env — sin token no hay API oficial.");
  } else {
    log(`  LOBBYPMS_API_TOKEN: configurado (${TOKEN.length} caracteres, empieza con "${TOKEN.slice(0, 4)}...")`);
    log("  (el token nunca se escribe completo en este reporte)");
  }

  // ---------------------------------------------------------------------------------------
  titulo("2. ¿RESPONDE LA API? (token + IP autorizada)");
  const salida = sumarDias(FECHA, Math.max(1, NOCHES));
  const prueba = await crudo("available-rooms", { start_date: FECHA, end_date: salida! });
  log(`  GET /available-rooms -> HTTP ${prueba.status}`);
  const cuerpo = JSON.stringify(prueba.data);

  if (prueba.status === 200) {
    log("  [OK] la API oficial respondió correctamente: token válido e IP autorizada.");
  } else if (/not set as a valid ip/i.test(cuerpo)) {
    log(`  [PROBLEMA] IP NO AUTORIZADA. Respuesta de LobbyPMS: ${cuerpo.slice(0, 300)}`);
    log("");
    log("  Qué hacer: entrar al panel de LobbyPMS -> Configuraciones -> API y agregar esa IP a las");
    log("  restricciones de IP. Es la IP de salida del servidor donde corre el bot (si el bot se");
    log("  muda a otro servidor, hay que autorizar la nueva).");
    log("  Mientras no esté autorizada, el bot NO se rompe: cae solo al motor público (ver punto 4).");
  } else if (/unauthenticated/i.test(cuerpo)) {
    log(`  [PROBLEMA] TOKEN INVÁLIDO O ROTADO. Respuesta: ${cuerpo.slice(0, 200)}`);
    log("  Qué hacer: generar/copiar el token de nuevo desde el panel de LobbyPMS (sección API).");
  } else {
    log(`  [PROBLEMA] respuesta inesperada: ${cuerpo.slice(0, 400)}`);
  }

  // ---------------------------------------------------------------------------------------
  titulo("3. DISPONIBILIDAD POR DÍA (lo que la API oficial da y el motor público no)");
  const porDia = await consultarDisponibilidadPorDia(FECHA, NOCHES);
  log(`  estado de la consulta: ${estadoUltimaConsultaOficial() ?? "(sin datos)"}`);
  if (!porDia) {
    log("  no se pudo obtener el detalle por día (ver el punto 2).");
  } else {
    log(`  ${porDia.length} día(s) con datos:`);
    for (const dia of porDia) {
      const detalle = dia.categorias
        .map((c) => `${c.nombreLobby} (${c.clase}/${c.capacidad}p): ${c.disponibles}`)
        .join(" | ");
      log(`   - ${dia.fecha}: ${detalle}`);
    }
  }

  // ---------------------------------------------------------------------------------------
  titulo("4. COMPARACIÓN CON EL MOTOR PÚBLICO (el respaldo que usa el bot hoy)");
  const publico = await consultarMotorPublico(FECHA, NOCHES);
  if (!publico) {
    log("  el motor público no respondió (si además falla la API oficial, el bot queda sin dato de cupo).");
  } else {
    for (const c of publico) {
      log(`   - ${c.nombreLobby} (${c.clase}/${c.capacidad}p): ${c.disponibles}`);
    }
  }

  const efectiva = await consultarDisponibilidad(FECHA, NOCHES);
  log("");
  log(`  lo que usaría el bot ahora mismo (consultarDisponibilidad): ${efectiva ? `${efectiva.length} categoría(s)` : "null (le confirmo con el equipo)"}`);
  if (efectiva) {
    for (const c of efectiva) log(`   - ${c.nombreLobby}: ${c.disponibles}`);
  }

  // ---------------------------------------------------------------------------------------
  titulo("5. FECHAS ALTERNATIVAS (lo que ofrece el bot cuando la fecha pedida está llena)");
  const alternativas = await buscarFechasAlternativas(FECHA, NOCHES, 7);
  if (!alternativas) {
    log("  null — sin API oficial no se pueden ofrecer fechas alternativas (el bot dice 'le confirmo con el equipo').");
  } else if (alternativas.length === 0) {
    log(`  ninguna de las fechas entre ${FECHA} y ${sumarDias(FECHA, 7)} tiene cupo para ${NOCHES} noche(s).`);
  } else {
    for (const alt of alternativas) {
      log(`   - ${alt.fecha}: ${alt.categorias.map((c) => `${c.nombreLobby} (${c.disponibles})`).join(", ")}`);
    }
  }

  // ---------------------------------------------------------------------------------------
  titulo("6. FORMA REAL DE LOS DEMÁS ENDPOINTS (para construir reservas y bloqueo)");
  log("  Solo GET. De bookings/invoices se imprimen únicamente los NOMBRES de los campos:");
  log("  traen datos de huéspedes reales y este reporte se comparte.");

  const conDatosPersonales = new Set(["bookings", "invoices", "users"]);
  const endpoints: [string, Record<string, string | number>][] = [
    ["rooms", {}],
    ["rate-plans", {}],
    ["products", {}],
    ["payment-methods", {}],
    ["channels", {}],
    ["occupancy", { start_date: FECHA, end_date: salida! }],
    ["bookings", { start_date: FECHA, end_date: sumarDias(FECHA, 30)! }],
    ["invoices", { start_date: FECHA, end_date: sumarDias(FECHA, 30)! }],
  ];

  for (const [ruta, params] of endpoints) {
    const r = await crudo(ruta, params);
    log("");
    log(`  --- GET /${ruta} -> HTTP ${r.status} ---`);
    if (r.status !== 200) {
      log(`     ${JSON.stringify(r.data).slice(0, 250)}`);
      continue;
    }
    log(`     registros: ${cuantas(r.data)}`);
    const campos = camposDe(r.data);
    log(`     campos: ${campos.length > 0 ? campos.join(", ") : "(respuesta sin objetos)"}`);
    if (!conDatosPersonales.has(ruta)) {
      const filas = Array.isArray(r.data) ? r.data : (r.data as any)?.data;
      const ejemplo = Array.isArray(filas) ? filas[0] : filas;
      if (ejemplo) log(`     ejemplo: ${JSON.stringify(ejemplo).slice(0, 600)}`);
    } else {
      log("     (valores omitidos a propósito: datos personales)");
    }
  }

  // ---------------------------------------------------------------------------------------
  titulo("RESUMEN");
  const estado = estadoUltimaConsultaOficial();
  if (estado === "ok") {
    log("  La API oficial funciona. Ya se puede avanzar con:");
    log("   - la sincronización de reservas (GET /bookings -> tabla `reservas` de Supabase);");
    log("   - el bloqueo real de cupo (POST /block) y la creación de reservas (POST /bookings),");
    log("     para lo cual todavía hace falta el diccionario de datos de soporte de LobbyPMS");
    log("     (ver MENSAJE-SOPORTE-LOBBYPMS.md en la raíz del proyecto).");
  } else if (estado === "ip_no_autorizada") {
    log("  Falta autorizar la IP de este servidor en el panel de LobbyPMS (Configuraciones -> API).");
    log("  El bot sigue funcionando con el motor público mientras tanto, pero sin detalle por día");
    log("  (o sea, sin poder ofrecer fechas alternativas).");
  } else if (estado === "sin_token") {
    log("  Falta LOBBYPMS_API_TOKEN en el .env.");
  } else {
    log(`  La API oficial no está disponible (${estado ?? "sin datos"}). Revisá los puntos 1 y 2.`);
  }
  log("");
  log(`Reporte guardado en: ${REPORTE}`);
}

main().catch((e) => {
  log("el script falló por completo:", String(e));
  process.exit(1);
});
