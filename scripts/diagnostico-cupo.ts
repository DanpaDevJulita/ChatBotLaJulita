/**
 * Diagnóstico del cupo: por qué el bot dice "no hay cupo" para una fecha que en el calendario
 * de LobbyPMS SÍ aparece libre. Creado el 2026-09-10 a raíz del caso del 11 de septiembre.
 *
 *   npx tsx scripts/diagnostico-cupo.ts
 *   npx tsx scripts/diagnostico-cupo.ts --fecha=2026-09-11
 *
 * SOLO LECTURA: hace GET a LobbyPMS y SELECT a Supabase. No crea, modifica, bloquea ni libera
 * nada, ni en LobbyPMS ni en la base.
 *
 * Responde tres preguntas concretas:
 *
 *   1. ¿`end_date` de `available-rooms` es INCLUSIVO o EXCLUSIVO? O sea: al pedir una noche
 *      (entrada 11, salida 12), ¿LobbyPMS contesta por el 11 solo, o por el 11 Y el 12? Esto
 *      es lo que decide si el bot está exigiendo, sin querer, que la noche SIGUIENTE también
 *      esté libre — que es la sospecha principal del caso del 11.
 *   2. ¿Qué ve el bot día por día, comparado con lo que muestra el calendario?
 *   3. ¿Qué hay en `bloqueos_temporales` y en qué estado? (¿se crean registros y no se
 *      actualizan? ¿quedaron bloqueos reales de LobbyPMS sin liberar?)
 */
import "dotenv/config";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { consultarDisponibilidad, liberarBlockLobby } from "../src/core/integrations/lobbypms.js";

const API_TOKEN = process.env.LOBBYPMS_API_TOKEN ?? "";
const API_URL = process.env.LOBBYPMS_API_URL ?? "https://api.lobbypms.com/api/v1";

function arg(nombre: string, porDefecto: string): string {
  const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.split("=")[1] : porDefecto;
}

const FECHA = arg("fecha", "2026-09-11");

function sumarDias(fechaISO: string, dias: number): string {
  const [a, m, d] = fechaISO.split("-").map(Number);
  const base = new Date(Date.UTC(a, m - 1, d));
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

interface CategoriaDia {
  fecha: string;
  categoryId: number | null;
  nombre: string;
  disponibles: number;
  minStay: number | null;
}

/** Devuelve la respuesta CRUDA aplanada: una fila por (fecha, categoría). */
async function consultar(startDate: string, endDate: string): Promise<CategoriaDia[] | null> {
  try {
    const res = await axios.get(`${API_URL}/available-rooms`, {
      params: { api_token: API_TOKEN, start_date: startDate, end_date: endDate, paginate: 100, page: 1 },
      timeout: 15000,
      headers: { Accept: "application/json" },
    });
    const filas = Array.isArray(res.data) ? res.data : res.data?.data;
    if (!Array.isArray(filas)) {
      console.log(`   ⚠️ respuesta con forma inesperada: ${JSON.stringify(res.data).slice(0, 200)}`);
      return null;
    }
    const salida: CategoriaDia[] = [];
    for (const fila of filas as any[]) {
      const fecha = String(fila?.date ?? "").slice(0, 10);
      for (const cat of (fila?.categories ?? []) as any[]) {
        salida.push({
          fecha,
          categoryId: cat?.category_id ?? null,
          nombre: String(cat?.name ?? "?"),
          disponibles: Number(cat?.available_rooms ?? 0),
          minStay: cat?.restrictions?.min_stay ?? null,
        });
      }
    }
    return salida;
  } catch (err: any) {
    const status = err?.response?.status;
    console.log(`   ❌ falló: ${status ? `HTTP ${status} — ` : ""}${err?.message ?? err}`);
    if (status === 401 || status === 403) {
      console.log("      (token inválido, o la IP de salida de esta máquina no está autorizada en LobbyPMS)");
    }
    return null;
  }
}

async function main() {
  console.log("=".repeat(92));
  console.log(`DIAGNÓSTICO DE CUPO — fecha en cuestión: ${FECHA} (1 noche)`);
  console.log("=".repeat(92));

  if (!API_TOKEN) {
    console.log("\n⚠️ LOBBYPMS_API_TOKEN no está en el .env — la parte de LobbyPMS no se puede probar.\n");
  } else {
    // ---- Pregunta 1: ¿end_date inclusivo o exclusivo? ----
    const salida = sumarDias(FECHA, 1);
    console.log(`\n1) ¿end_date es inclusivo o exclusivo?\n`);

    console.log(`   a) start_date=${FECHA}  end_date=${FECHA}   (el mismo día en los dos)`);
    const mismoDia = await consultar(FECHA, FECHA);
    if (mismoDia) {
      const fechas = [...new Set(mismoDia.map((c) => c.fecha))].sort();
      console.log(`      -> LobbyPMS contestó por ${fechas.length} fecha(s): ${fechas.join(", ") || "(ninguna)"}`);
    }

    console.log(`\n   b) start_date=${FECHA}  end_date=${salida}   (lo que manda el bot para 1 noche)`);
    const unaNoche = await consultar(FECHA, salida);
    if (unaNoche) {
      const fechas = [...new Set(unaNoche.map((c) => c.fecha))].sort();
      console.log(`      -> LobbyPMS contestó por ${fechas.length} fecha(s): ${fechas.join(", ") || "(ninguna)"}`);
      console.log();
      if (fechas.length >= 2) {
        console.log(`      🔴 CONCLUSIÓN: end_date es INCLUSIVO. Al pedir 1 noche del ${FECHA}, el bot está`);
        console.log(`         preguntando por el ${FECHA} Y por el ${salida}. Como el bot exige que la categoría`);
        console.log(`         tenga cupo en TODAS las fechas que le contestan (toma el mínimo), si el ${salida}`);
        console.log(`         está lleno el bot cree que el ${FECHA} no tiene cupo. ESTE ES EL BUG.`);
      } else if (fechas.length === 1) {
        console.log(`      🟢 end_date es EXCLUSIVO (solo contestó por el ${FECHA}), que es lo que el código`);
        console.log(`         asume hoy. Entonces el "no hay cupo" viene de otro lado — mirar el punto 3.`);
      }
      console.log(`\n      Detalle por fecha y categoría de la consulta (b):`);
      for (const c of unaNoche) {
        console.log(
          `        ${c.fecha}  ${String(c.nombre).padEnd(28)} cupo=${c.disponibles}` +
            `  category_id=${c.categoryId}${c.minStay ? `  min_stay=${c.minStay}` : ""}`
        );
      }
    }

    // ---- Pregunta 2: el panorama día por día ----
    console.log(`\n\n2) Lo que ve el bot día por día (${sumarDias(FECHA, -1)} a ${sumarDias(FECHA, 8)})`);
    console.log(`   Comparalo contra el calendario de LobbyPMS: si acá dice 1 y en el calendario 1, la`);
    console.log(`   lectura está bien y el problema es del rango; si no coinciden, el problema es la lectura.\n`);
    const rango = await consultar(sumarDias(FECHA, -1), sumarDias(FECHA, 8));
    if (rango) {
      const porNombre = new Map<string, Map<string, number>>();
      const fechas = [...new Set(rango.map((c) => c.fecha))].sort();
      for (const c of rango) {
        if (!porNombre.has(c.nombre)) porNombre.set(c.nombre, new Map());
        porNombre.get(c.nombre)!.set(c.fecha, c.disponibles);
      }
      console.log(`   ${"categoría".padEnd(28)} ${fechas.map((f) => f.slice(5)).join("  ")}`);
      for (const [nombre, porFecha] of porNombre) {
        const celdas = fechas.map((f) => String(porFecha.get(f) ?? "-").padStart(5)).join("  ");
        console.log(`   ${nombre.padEnd(28)} ${celdas}`);
      }
    }
  }

  // ---- Pregunta 3: los registros en Supabase ----
  console.log(`\n\n3) Registros en bloqueos_temporales (los últimos 20)\n`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("   ⚠️ Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el .env.");
  } else {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from("bloqueos_temporales")
      .select("id, canal, external_id, clase_domo, capacidad, fecha_entrada, estado, personas, ninos, lobby_block_id, lobby_booking_id, creado_en, expira_en")
      .order("id", { ascending: false })
      .limit(20);
    if (error) {
      console.log(`   ❌ ${error.message}`);
    } else if (!data || data.length === 0) {
      console.log("   (no hay ningún registro)");
    } else {
      const ahora = Date.now();
      console.log(
        `   ${"id".padStart(4)} ${"entrada".padEnd(11)} ${"clase/cap".padEnd(12)} ${"estado".padEnd(11)} ` +
          `${"vence".padEnd(9)} ${"cuenta?".padEnd(8)} block_id  booking_id`
      );
      for (const b of data as any[]) {
        const vencido = new Date(b.expira_en).getTime() <= ahora;
        // Esta es exactamente la condición de contarBloqueosActivos(): lo que le RESTA cupo al bot.
        const cuenta = b.estado === "pendiente" && !vencido;
        console.log(
          `   ${String(b.id).padStart(4)} ${String(b.fecha_entrada).padEnd(11)} ` +
            `${`${b.clase_domo}/${b.capacidad}`.padEnd(12)} ${String(b.estado).padEnd(11)} ` +
            `${(vencido ? "vencido" : "vigente").padEnd(9)} ${(cuenta ? "SÍ RESTA" : "no").padEnd(8)} ` +
            `${String(b.lobby_block_id ?? "-").padEnd(9)} ${b.lobby_booking_id ?? "-"}`
        );
      }
      const fantasmas = (data as any[]).filter((b) => b.lobby_block_id && b.estado !== "pendiente" && !b.lobby_booking_id);
      const restan = (data as any[]).filter(
        (b) => b.estado === "pendiente" && new Date(b.expira_en).getTime() > ahora
      );
      console.log(`\n   Bloqueos internos que HOY le restan cupo al bot: ${restan.length}`);
      if (restan.length > 0) {
        for (const b of restan) console.log(`     · #${b.id} ${b.fecha_entrada} ${b.clase_domo}/${b.capacidad} (${b.external_id})`);
      }
      console.log(
        `\n   Registros ya cerrados que TENÍAN un bloqueo real en LobbyPMS: ${fantasmas.length}` +
          (fantasmas.length > 0
            ? `\n     -> block_id(s): ${fantasmas.map((b) => b.lobby_block_id).join(", ")}` +
              `\n     Si alguno de esos sigue apareciendo como "Blo..." en el calendario de LobbyPMS,` +
              `\n     el DELETE /block no se ejecutó o no surtió efecto (bloqueo fantasma).`
            : "")
      );
    }
  }

  // ---- Pregunta 4: qué contesta HOY el código del bot para esa fecha ----
  if (API_TOKEN) {
    console.log(`\n\n4) Lo que devuelve la función que usa el bot: consultarDisponibilidad("${FECHA}", 1)\n`);
    const delBot = await consultarDisponibilidad(FECHA, 1);
    if (!delBot) {
      console.log("   (no se pudo consultar — la API no respondió por ninguna de las dos vías)");
    } else {
      for (const c of delBot) {
        console.log(
          `     ${String(c.nombreLobby ?? c.clase).padEnd(28)} clase=${String(c.clase).padEnd(9)} ` +
            `cap=${c.capacidad}  cupo=${c.disponibles}`
        );
      }
      console.log(
        `\n   Esto es lo que el bot cree para 1 noche del ${FECHA}. Tiene que coincidir con la fila del` +
          `\n   ${FECHA} del punto 1b (y con el calendario). Si acá sale 0 donde el punto 1b dice 1,` +
          `\n   el arreglo del rango no está aplicado (¿reiniciaste el worker?).`
      );
    }
  }

  // ---- Opcional: liberar un bloqueo fantasma ----
  const aLiberar = process.argv.find((a) => a.startsWith("--liberar-bloqueo="))?.split("=")[1];
  if (aLiberar) {
    console.log(`\n\n5) Liberando el bloqueo real block_id=${aLiberar} en LobbyPMS (DELETE /block)\n`);
    const ok = await liberarBlockLobby(Number(aLiberar));
    console.log(
      ok
        ? `   ✅ LobbyPMS confirmó la liberación. Volvé a correr el diagnóstico sin este parámetro\n` +
            `      para ver el cupo actualizado.`
        : `   ❌ LobbyPMS NO confirmó la liberación (el detalle quedó arriba). Si dice que no existe,\n` +
            `      el bloqueo ya se había vencido solo y el "Blo..." del calendario es otro.`
    );
  } else {
    console.log(
      `\n   (para liberar un bloqueo fantasma: npx tsx scripts/diagnostico-cupo.ts --liberar-bloqueo=<block_id>)`
    );
  }

  console.log("\n" + "=".repeat(92) + "\n");
}

main().catch((err) => {
  console.error("Falló el diagnóstico:", err);
  process.exit(1);
});
