/**
 * Prueba del parser de disponibilidad de LobbyPMS — creado el 2026-09-10.
 *
 * NO necesita red ni que la IP esté autorizada: levanta un servidor local que imita la respuesta
 * REAL documentada de LobbyPMS (`https://app.lobbypms.com/api`) y verifica que el parser la lea
 * bien. Es la prueba que se corre siempre; `scripts/probar-lobbypms.ts` es la otra, la que pega
 * contra la API de verdad.
 *
 *   npx tsx scripts/probar-parser-lobbypms.ts
 *
 * Por qué existe: el informe extraído del n8n mostraba la disponibilidad como un arreglo PLANO
 * (`{date, name, available_rooms}`), que es lo que veía el agente de IA de ese workflow. La API
 * en realidad devuelve las categorías ANIDADAS por fecha (`data[].categories[]`) y con dos datos
 * que nos hacen falta: `category_id` (obligatorio para bloquear y reservar) y
 * `restrictions.min_stay`. El parser se escribió primero contra la forma equivocada, así que esta
 * prueba fija el contrato correcto para que no se vuelva a romper.
 */
import http from "node:http";

const PUERTO = 8731;
const TOKEN = "token_valido_de_prueba";

/**
 * Los 3 días del escenario, armados para cubrir los casos que importan:
 *   19: cupo normal, y DOMO ROMANTIC con min_stay=2 (no se puede vender 1 noche);
 *   20: CHALET lleno, y DOMO ROMANTIC OMITIDA a propósito (LobbyPMS podría no informarla);
 *   21: DOMO DELUXE en 0.
 */
const DIAS: Record<string, unknown[]> = {
  "2026-12-19": [
    { category_id: 2523, name: "CHALET", available_rooms: 2, prices: [{ people: 2, value: 1690000 }], restrictions: { min_stay: 0, max_stay: 0, lead_days: 0 } },
    { category_id: 2524, name: "DOMO ROMANTIC", available_rooms: 1, prices: [{ people: 2, value: 890000 }], restrictions: { min_stay: 2, max_stay: 0, lead_days: 0 } },
    { category_id: 2525, name: "DOMO FAMILIAR", available_rooms: 0, prices: [{ people: 4, value: 1200000 }], restrictions: { min_stay: 0, max_stay: 0, lead_days: 0 } },
    { category_id: 2526, name: "DOMO DELUXE", available_rooms: 3, prices: [{ people: 2, value: 1450000 }], restrictions: { min_stay: 0, max_stay: 0, lead_days: 0 } },
  ],
  "2026-12-20": [
    { category_id: 2523, name: "CHALET", available_rooms: 0, restrictions: { min_stay: 0 } },
    { category_id: 2525, name: "DOMO FAMILIAR", available_rooms: 2, restrictions: { min_stay: 0 } },
    { category_id: 2526, name: "DOMO DELUXE", available_rooms: 1, restrictions: { min_stay: 0 } },
  ],
  "2026-12-21": [
    { category_id: 2523, name: "CHALET", available_rooms: 4, restrictions: { min_stay: 0 } },
    { category_id: 2524, name: "DOMO ROMANTIC", available_rooms: 2, restrictions: { min_stay: 0 } },
    { category_id: 2525, name: "DOMO FAMILIAR", available_rooms: 1, restrictions: { min_stay: 0 } },
    { category_id: 2526, name: "DOMO DELUXE", available_rooms: 0, restrictions: { min_stay: 0 } },
  ],
};

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!url.pathname.endsWith("/available-rooms")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Resource Not Found." }));
  }
  if (url.searchParams.get("api_token") !== TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Unauthenticated." }));
  }
  const start = url.searchParams.get("start_date") ?? "";
  const end = url.searchParams.get("end_date") ?? "";
  // [start_date, end_date): el día de salida NO se informa, igual que hace LobbyPMS.
  const data = Object.entries(DIAS)
    .filter(([f]) => f >= start && f < end)
    .map(([date, categories]) => ({ date, categories }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      data,
      meta: { total_records: data.length, current_page: 1, records_per_page: 100, total_pages: 1 },
    })
  );
});

await new Promise<void>((listo) => servidor.listen(PUERTO, () => listo()));

// El módulo lee el token y la URL al cargarse, así que se configuran ANTES de importarlo.
// (A propósito no se carga dotenv: esta prueba nunca debe pegarle a la API real.)
process.env.LOBBYPMS_API_TOKEN = TOKEN;
process.env.LOBBYPMS_API_URL = `http://127.0.0.1:${PUERTO}/api/v1`;

const { consultarDisponibilidadPorDia, consultarDisponibilidad, buscarFechasAlternativas, estadoUltimaConsultaOficial } =
  await import("../src/core/integrations/lobbypms.js");

let fallos = 0;
function verificar(nombre: string, condicion: boolean, detalle = ""): void {
  console.log(`${condicion ? "  [ok]  " : " [FALLA]"} ${nombre}${detalle ? ` — ${detalle}` : ""}`);
  if (!condicion) fallos++;
}

console.log("PRUEBA DEL PARSER DE DISPONIBILIDAD DE LOBBYPMS (servidor local, sin red)");
console.log("");
console.log("-- 1. Lectura de la forma real: data[].categories[] --");
const porDia = await consultarDisponibilidadPorDia("2026-12-19", 1);
verificar("el estado de la consulta queda en 'ok'", estadoUltimaConsultaOficial() === "ok", String(estadoUltimaConsultaOficial()));
verificar("1 noche devuelve 1 día", porDia?.length === 1, `días=${porDia?.length}`);
const dia19 = porDia?.[0];
verificar("lee las 4 categorías de la fecha", dia19?.categorias.length === 4, `n=${dia19?.categorias.length}`);
const chalet = dia19?.categorias.find((c) => c.nombreLobby === "CHALET");
verificar("CHALET: 2 disponibles", chalet?.disponibles === 2, `${chalet?.disponibles}`);
verificar("CHALET: captura category_id (hace falta para bloquear/reservar)", chalet?.categoryId === 2523, `${chalet?.categoryId}`);
verificar("CHALET: mapeado a chalet/2p", chalet?.clase === "chalet" && chalet?.capacidad === 2);
const romantic = dia19?.categorias.find((c) => c.nombreLobby === "DOMO ROMANTIC");
verificar("DOMO ROMANTIC: captura restrictions.min_stay", romantic?.minStay === 2, `${romantic?.minStay}`);
verificar("DOMO ROMANTIC: mapeado a clasico/2p", romantic?.clase === "clasico" && romantic?.capacidad === 2);
const familiar = dia19?.categorias.find((c) => c.nombreLobby === "DOMO FAMILIAR");
verificar("DOMO FAMILIAR: mapeado a clasico/4p", familiar?.clase === "clasico" && familiar?.capacidad === 4);

console.log("");
console.log("-- 2. Una noche: min_stay tiene que anular la categoría que exige 2 --");
const unaNoche = await consultarDisponibilidad("2026-12-19", 1);
verificar(
  "ROMANTIC queda en 0 (exige 2 noches y se pidió 1)",
  unaNoche?.find((c) => c.nombreLobby === "DOMO ROMANTIC")?.disponibles === 0
);
verificar("CHALET sigue con 2", unaNoche?.find((c) => c.nombreLobby === "CHALET")?.disponibles === 2);

console.log("");
console.log("-- 3. Dos noches: mínimo entre noches, y categoría no informada --");
const dosNoches = await consultarDisponibilidad("2026-12-19", 2);
verificar("CHALET en 0 (la segunda noche está llena)", dosNoches?.find((c) => c.nombreLobby === "CHALET")?.disponibles === 0);
verificar("DELUXE = min(3, 1) = 1", dosNoches?.find((c) => c.nombreLobby === "DOMO DELUXE")?.disponibles === 1);
verificar(
  "ROMANTIC en 0 (no vino informada la segunda noche)",
  dosNoches?.find((c) => c.nombreLobby === "DOMO ROMANTIC")?.disponibles === 0
);
verificar("FAMILIAR en 0 (la primera noche tenía 0)", dosNoches?.find((c) => c.nombreLobby === "DOMO FAMILIAR")?.disponibles === 0);

console.log("");
console.log("-- 4. Fechas alternativas de 1 noche --");
const alt = await buscarFechasAlternativas("2026-12-19", 1, 2);
verificar("no devuelve null", alt !== null);
const f19 = alt?.find((a) => a.fecha === "2026-12-19");
const f20 = alt?.find((a) => a.fecha === "2026-12-20");
const f21 = alt?.find((a) => a.fecha === "2026-12-21");
verificar("el 19 ofrece 2 alojamientos", f19?.categorias.length === 2, f19?.categorias.map((c) => c.nombreLobby).join(", "));
verificar("el 19 NO ofrece ROMANTIC (min_stay 2)", !f19?.categorias.some((c) => c.nombreLobby === "DOMO ROMANTIC"));
verificar("el 20 ofrece 2 alojamientos", f20?.categorias.length === 2, f20?.categorias.map((c) => c.nombreLobby).join(", "));
verificar("el 21 ofrece 3 alojamientos", f21?.categorias.length === 3, f21?.categorias.map((c) => c.nombreLobby).join(", "));
verificar("el 21 NO ofrece DELUXE (0 disponibles)", !f21?.categorias.some((c) => c.nombreLobby === "DOMO DELUXE"));

servidor.close();
console.log("");
console.log(fallos === 0 ? "RESULTADO: todas las verificaciones pasaron ✅" : `RESULTADO: ${fallos} verificación(es) FALLARON ❌`);
process.exit(fallos === 0 ? 0 : 1);
