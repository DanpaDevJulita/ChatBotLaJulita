/**
 * Lee la ESTRUCTURA REAL de la base (no lo que dice sql/schema.sql, que puede estar
 * desactualizado) y la compara con lo que el bot necesita para registrar clientes,
 * acompañantes y reservas.
 *
 *   npx tsx scripts/estructura-db.ts
 *
 * Cómo lo hace: PostgREST (la API de Supabase) publica su propio esquema OpenAPI en la raíz de
 * /rest/v1/, con las columnas de cada tabla, sus tipos, cuáles son obligatorias y a qué llaves
 * foráneas apuntan. Es la fuente más confiable sin abrir el editor SQL.
 *
 * Deja el reporte en estructura-db-<fecha>.txt
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { supabase, supabaseConfigured } from "../src/core/db/supabase.js";

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const REPORTE = path.join(process.cwd(), `estructura-db-${stamp}.txt`);

function log(...partes: unknown[]): void {
  const linea = partes.map((p) => (typeof p === "string" ? p : JSON.stringify(p, null, 2))).join(" ");
  console.log(linea);
  fs.appendFileSync(REPORTE, linea + "\n", "utf-8");
}

const problemas: string[] = [];
function problema(t: string): void {
  problemas.push(t);
  log("  [PROBLEMA] " + t);
}
function ok(t: string): void {
  log("  [OK]       " + t);
}
function aviso(t: string): void {
  log("  [AVISO]    " + t);
}

/** Tablas que le importan al flujo de reserva, y qué espera el código de cada una. */
const TABLAS = [
  "tipo_documento",
  "estado",
  "clientes",
  "acompanantes",
  "reservas",
  "planes",
  "domos",
  "clase_domo",
  "adicionales",
  "tipo_adicional",
];

interface Columna {
  nombre: string;
  tipo: string;
  formato: string;
  obligatoria: boolean;
  pk: boolean;
  fk: string | null;
  defecto: string | null;
}

function parsearTabla(definicion: any): Columna[] {
  const requeridas: string[] = definicion?.required ?? [];
  const propiedades = definicion?.properties ?? {};
  return Object.entries(propiedades).map(([nombre, meta]: [string, any]) => {
    const descripcion: string = meta?.description ?? "";
    const fk = descripcion.match(/<fk table='([^']+)' column='([^']+)'\/>/);
    return {
      nombre,
      tipo: meta?.type ?? "?",
      formato: meta?.format ?? "?",
      obligatoria: requeridas.includes(nombre),
      pk: /<pk\/>/.test(descripcion),
      fk: fk ? `${fk[1]}.${fk[2]}` : null,
      defecto: meta?.default != null ? String(meta.default) : null,
    };
  });
}

async function main(): Promise<void> {
  log("ESTRUCTURA REAL DE LA BASE — bot La Julita");
  log(`fecha: ${new Date().toISOString()}`);
  log(`archivo: ${REPORTE}`);
  log("");
  log("Nota: 'obligatoria' = la API la exige al insertar (NOT NULL y sin valor por defecto).");

  if (!supabaseConfigured) {
    problema("Supabase no está configurado en el .env");
    return;
  }

  const url = `${process.env.SUPABASE_URL}/rest/v1/`;
  const apikey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  let definiciones: Record<string, any> = {};
  try {
    const res = await axios.get(url, {
      headers: { apikey, Authorization: `Bearer ${apikey}`, Accept: "application/openapi+json" },
      timeout: 30_000,
    });
    definiciones = res.data?.definitions ?? {};
    log(`\ntablas visibles en la API: ${Object.keys(definiciones).length}`);
  } catch (e) {
    const a = e as any;
    problema(`no pude leer el esquema de la API: ${a?.response?.status ?? ""} ${a?.message ?? String(e)}`);
    return;
  }

  const columnasPorTabla = new Map<string, Columna[]>();

  for (const tabla of TABLAS) {
    log("");
    log("=".repeat(88));
    const definicion = definiciones[tabla];
    if (!definicion) {
      problema(`la tabla \`${tabla}\` NO existe (o no es visible para esta llave)`);
      continue;
    }
    const columnas = parsearTabla(definicion);
    columnasPorTabla.set(tabla, columnas);

    const { count, error } = await supabase.from(tabla).select("*", { count: "exact", head: true });
    log(`== ${tabla} — ${error ? `error al contar: ${error.message}` : `${count} fila(s)`}`);
    log("=".repeat(88));
    for (const c of columnas) {
      const marcas = [
        c.pk ? "PK" : null,
        c.obligatoria ? "OBLIGATORIA" : "opcional",
        c.fk ? `FK -> ${c.fk}` : null,
        c.defecto ? `default=${c.defecto}` : null,
      ].filter(Boolean);
      log(`   ${c.nombre.padEnd(22)} ${(c.tipo + "/" + c.formato).padEnd(24)} ${marcas.join(", ")}`);
    }
  }

  // ---- Verificación de lo que el bot necesita ----
  log("");
  log("=".repeat(88));
  log("== ¿PUEDE EL BOT REGISTRAR UNA RESERVA CON SUS ACOMPAÑANTES?");
  log("=".repeat(88));

  const esperado: [string, string[], string][] = [
    ["clientes", ["nombre", "tipo_documento_id", "numero_documento", "celular"], "datos de quien reserva"],
    ["acompanantes", ["nombre", "tipo_documento_id", "numero_documento"], "datos del acompañante"],
    ["reservas", ["cliente_id", "plan_id", "fecha_reservada", "numero_huespedes", "estado_id"], "la reserva que los une"],
  ];

  for (const [tabla, columnasEsperadas, para] of esperado) {
    const columnas = columnasPorTabla.get(tabla);
    if (!columnas) continue;
    const nombres = columnas.map((c) => c.nombre);
    const faltantes = columnasEsperadas.filter((c) => !nombres.includes(c));
    if (faltantes.length > 0) {
      problema(`en \`${tabla}\` (${para}) faltan columnas que el código usa: ${faltantes.join(", ")}`);
    } else {
      ok(`\`${tabla}\` tiene las columnas que el código usa (${para})`);
    }

    // Obligatorias que el código NO manda
    const queMandaElCodigo: Record<string, string[]> = {
      clientes: ["nombre", "tipo_documento_id", "numero_documento", "celular", "correo"],
      acompanantes: ["nombre", "tipo_documento_id", "numero_documento", "celular", "correo", "reserva_id"],
      // (reserva_id se deja en la lista por si el vínculo con la reserva se reactiva algún día)
      reservas: ["cliente_id", "plan_id", "fecha_reservada", "numero_huespedes", "valor_total", "total", "estado_id"],
    };
    // OJO: una columna obligatoria CON valor por defecto no es un bloqueo — la base la llena
    // sola (es el caso de `reservas.fecha_reserva`, default=now()). Antes las marcaba como
    // problema y eso era un falso positivo.
    const sinCubrir = columnas
      .filter((c) => c.obligatoria && !c.pk && !c.defecto && !queMandaElCodigo[tabla].includes(c.nombre))
      .map((c) => `${c.nombre}${c.fk ? ` (FK -> ${c.fk})` : ""}`);
    if (sinCubrir.length > 0) {
      problema(
        `en \`${tabla}\` hay columnas OBLIGATORIAS que el bot no puede llenar: ${sinCubrir.join(", ")} — ` +
          "el insert va a fallar hasta que se vuelvan opcionales o el bot tenga ese dato"
      );
    } else {
      ok(`en \`${tabla}\` no hay obligatorias sin cubrir`);
    }
  }

  // ---- ¿Lo que el PANEL escribe existe en la base? --------------------------------------
  // [2026-09-09] El panel mandaba `precio`, `capacidad` y `orden` a `planes`: tres columnas
  // que ya no existen. Cada "Guardar" moría con 42703 y nadie se enteraba hasta abrir el
  // panel. Este chequeo compara columna por columna, así la deriva se ve en el reporte.
  log("");
  log("=".repeat(88));
  log("== ¿PUEDE EL EQUIPO EDITAR PRECIOS DESDE EL PANEL?");
  log("=".repeat(88));

  const escribeElPanel: [string, string[]][] = [
    [
      "planes",
      ["id", "nombre", "descripcion", "precio_entre_semana", "precio_fin_de_semana", "precio_fin_de_semana_puente", "activo"],
    ],
    ["adicionales", ["id", "nombre", "descripcion", "precio", "tipo_adicional_id", "estado"]],
  ];

  for (const [tabla, columnasQueEscribe] of escribeElPanel) {
    const columnas = columnasPorTabla.get(tabla);
    if (!columnas) continue;
    const nombres = columnas.map((c) => c.nombre);
    const inexistentes = columnasQueEscribe.filter((c) => !nombres.includes(c));
    if (inexistentes.length > 0) {
      problema(
        `el panel le escribe a \`${tabla}\` columnas que NO existen: ${inexistentes.join(", ")} — ` +
          "guardar desde el panel va a fallar con 42703 (revisá src/web/admin/public/admin.js)"
      );
    } else {
      ok(`\`${tabla}\`: las columnas que edita el panel existen todas`);
    }
    const noEditables = nombres.filter((c) => !columnasQueEscribe.includes(c));
    if (noEditables.length > 0) log(`  ${tabla}: columnas que el panel NO edita: ${noEditables.join(", ")}`);
  }

  // Catálogos con datos
  // `estado` solo hace falta si el bot crea la reserva (CREAR_RESERVA_DESDE_BOT=true). En el
  // modo que pidió el equipo el bot solo escribe cliente + acompañantes: vacía no rompe nada.
  const creaReservas = (process.env.CREAR_RESERVA_DESDE_BOT ?? "false").toLowerCase() === "true";
  for (const [tabla, para, obligatoria] of [
    ["tipo_documento", "sin filas, no se puede insertar ningún cliente ni acompañante", true],
    ["estado", "sin filas, no se puede crear ninguna reserva", creaReservas],
  ] as [string, string, boolean][]) {
    const { count } = await supabase.from(tabla).select("*", { count: "exact", head: true });
    if (!count && obligatoria) problema(`la tabla \`${tabla}\` está VACÍA: ${para} (corré sql/reserva-datos-cliente.sql)`);
    else if (!count) log(`  \`${tabla}\` está vacía — no hace falta mientras CREAR_RESERVA_DESDE_BOT=false (${para})`);
    else {
      const { data } = await supabase.from(tabla).select("*").limit(20);
      log(`  contenido de ${tabla}: ${JSON.stringify(data)}`);
      ok(`\`${tabla}\` tiene ${count} fila(s)`);
    }
  }

  log("");
  log("=".repeat(88));
  log(`== RESUMEN: ${problemas.length} problema(s)`);
  log("=".repeat(88));
  problemas.forEach((p, i) => log(`   ${i + 1}. ${p}`));
  log("");
  log(`Reporte guardado en: ${REPORTE}`);
  process.exit(0);
}

main();
