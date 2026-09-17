/**
 * PRUEBA: un grupo que no cabe en un domo se cotiza con VARIOS domos, familiares primero y
 * parejas después — en vez de escalar al equipo.
 *
 * Pedido de Daniel (2026-09-17), después de esta conversación real:
 *   Cliente: 15 personas para el 21.
 *   Bot:     "para 15 personas no tengo esa información a la mano... ¿le paso tu consulta al equipo?"
 * Con domos familiares y de pareja libres, eso era una venta perdida. Regla acordada: "primero
 * familias, luego parejas". Ver src/agentes/ventas/herramientas/grupos.ts.
 *
 * Inventario simulado (el real de La Julita): 2 DOMO FAMILIAR (4p), 2 DOMO ROMANTIC (2p),
 * 3 CHALET (2p), 1 DOMO DELUXE (2p).
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";
process.env.LOBBYPMS_API_URL ||= "https://prueba.lobbypms.local/api/v1";

const { instalarSupabaseFalso, instalarLobbyFalso, lobbyResponderaCategorias } = await import("./fakes.js");
instalarSupabaseFalso();
instalarLobbyFalso();

const { consultarPlanesTool } = await import("../src/agentes/ventas/herramientas/planes.js");
const { cabeEnUnDomo, repartirEnDomos } = await import("../src/agentes/ventas/herramientas/grupos.js");

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}
function mostrar(r: any) {
  console.log(String(r.reply_to_user ?? "").split("\n").map((l: string) => `  | ${l}`).join("\n"));
}
const ctx = { channel: "whatsapp", externalId: "+573001110099" } as any;

const HOTEL_COMPLETO = [
  { name: "DOMO FAMILIAR", available: 2 },
  { name: "DOMO ROMANTIC", available: 2 },
  { name: "CHALET", available: 3 },
  { name: "DOMO DELUXE", available: 1 },
];
// sábado (tarifa fin de semana)
const FECHA = "2026-09-26";

console.log("CASO 0. La regla de capacidad de UN domo\n");
{
  revisar(cabeEnUnDomo(2, 0) && cabeEnUnDomo(3, 0) && cabeEnUnDomo(2, 2) && cabeEnUnDomo(1, 2), "2 adultos, 3 adultos, 2+2 y 1+2 caben en un domo", "una combinación que cabe se marcó como que no");
  revisar(!cabeEnUnDomo(4, 0) && !cabeEnUnDomo(3, 1) && !cabeEnUnDomo(5, 0), "4 adultos, 3+1 y 5 personas NO caben en un domo", "una combinación que no cabe se marcó como que sí");
  const libres = { familiares: 2, parejas: 6, parejasPorClase: new Map([["clasico", 2], ["chalet", 3], ["deluxe", 1]]), origen: "lobby" as const };
  const r15 = repartirEnDomos({ adultos: 15, ninos: 0, asumidoTodosAdultos: true }, libres);
  revisar(
    r15.sinAcomodar === 0 && r15.domos.filter((d) => d.tipo === "familiar").length === 2 && r15.domos.filter((d) => d.tipo === "pareja").length === 5,
    "15 adultos = 2 familiares (3+3) + 5 parejas (2+2+2+2+1)",
    `reparto de 15: ${JSON.stringify(r15)}`
  );
  const r6 = repartirEnDomos({ adultos: 4, ninos: 2, asumidoTodosAdultos: false }, libres);
  revisar(
    r6.sinAcomodar === 0 && r6.domos.length === 2 && r6.domos[0].tipo === "familiar" && r6.domos[0].ninos === 2 && r6.domos[1].tipo === "pareja",
    "4 adultos + 2 niños = 1 familiar (2 adultos + 2 niños) + 1 pareja (2 adultos)",
    `reparto de 4+2: ${JSON.stringify(r6)}`
  );
  const r22 = repartirEnDomos({ adultos: 22, ninos: 0, asumidoTodosAdultos: true }, libres);
  revisar(r22.sinAcomodar > 0, "22 adultos NO caben en el hotel (6 + 12 = 18): quedan afuera", `22 adultos: ${JSON.stringify(r22)}`);
}

console.log("\nCASO 1. 15 personas para un sábado, hotel con cupo: se arma, no se escala\n");
{
  lobbyResponderaCategorias(HOTEL_COMPLETO);
  const r: any = await consultarPlanesTool.handler({ personas: 15, fecha: FECHA, segmento: "familia" }, ctx);
  mostrar(r);
  revisar(r.result?.modo === "grupo", "entró en modo grupo", `modo=${r.result?.modo}`);
  revisar(r.result?.alcanza === true && r.result?.domos === 7, "alcanza con 7 domos", `alcanza=${r.result?.alcanza} domos=${r.result?.domos}`);
  revisar(/2 × PLAN FAMILIAR 3 PERSONAS/.test(r.reply_to_user), "2 domos familiares con el plan de 3 personas", "no aparecen los 2 familiares de 3");
  revisar(/5 × PLAN .*DOS PERSONAS/.test(r.reply_to_user), "5 domos de pareja", "no aparecen los 5 de pareja");
  revisar(/Total: \$/.test(r.reply_to_user) && r.result?.total > 0, `total sumado: ${r.result?.total}`, "no hay total");
  revisar(/SÍ hay cupo/.test(r.reply_to_user), "confirma el cupo real de la fecha", "no confirma cupo");
  revisar(/contando a todos como adultos/.test(r.reply_to_user), "pregunta por los niños", "no pregunta por niños");
  revisar(r.forzarTextoLiteral === true, "el mensaje sale literal (cifras sumadas)", "no está marcado como literal");
  revisar(!/equipo de La Julita/.test(r.reply_to_user), "NO escala al equipo", "sigue escalando al equipo");
}

console.log("\nCASO 2. 6 personas (4 adultos + 2 niños): 1 familiar + 1 pareja\n");
{
  lobbyResponderaCategorias(HOTEL_COMPLETO);
  const r: any = await consultarPlanesTool.handler({ personas: 6, adultos: 4, ninos: 2, fecha: FECHA }, ctx);
  mostrar(r);
  revisar(r.result?.modo === "grupo" && r.result?.domos === 2, "2 domos", `modo=${r.result?.modo} domos=${r.result?.domos}`);
  revisar(/1 × PLAN FAMILIAR 4 PERSONAS \(2 adultos y 2 niños/.test(r.reply_to_user), "el familiar va con el plan de 4 (2 adultos y 2 niños)", "el familiar no salió con el plan de 4");
  revisar(/1 × PLAN .*DOS PERSONAS/.test(r.reply_to_user), "1 domo de pareja para los otros 2 adultos", "falta el de pareja");
  revisar(/valor adicional según la edad/.test(r.reply_to_user), "avisa del adicional por niños", "no avisa del adicional por niños");
}

console.log("\nCASO 3. 8 adultos, sin fecha: arma la propuesta con el inventario y pide la fecha\n");
{
  const r: any = await consultarPlanesTool.handler({ personas: 8 }, ctx);
  mostrar(r);
  revisar(r.result?.modo === "grupo" && r.result?.alcanza === true, "arma la propuesta aunque no haya fecha", `modo=${r.result?.modo} alcanza=${r.result?.alcanza}`);
  revisar(/Dime la fecha exacta/.test(r.reply_to_user), "pide la fecha para confirmar cupo", "no pide la fecha");
  revisar(r.result?.cupo_confirmado === false, "deja claro que el cupo no está confirmado", "dice que confirmó cupo sin fecha");
}

console.log("\nCASO 4. 15 personas pero solo quedan 3 domos libres: NO alcanza, ofrece otra fecha (no inventa)\n");
{
  lobbyResponderaCategorias([
    { name: "DOMO FAMILIAR", available: 1 },
    { name: "DOMO ROMANTIC", available: 0 },
    { name: "CHALET", available: 2 },
    { name: "DOMO DELUXE", available: 0 },
  ]);
  const r: any = await consultarPlanesTool.handler({ personas: 15, fecha: FECHA }, ctx);
  mostrar(r);
  revisar(r.result?.alcanza === false, "reconoce que no alcanza", `alcanza=${r.result?.alcanza}`);
  revisar(/no me alcanzan los domos libres/.test(r.reply_to_user) && /fecha cercana/.test(r.reply_to_user), "lo dice y ofrece buscar otra fecha", "no ofrece otra fecha");
}

console.log("\nCASO 5. 4 personas sin decir adultos: sigue el flujo normal (plan familiar de 4), no el de grupo\n");
{
  lobbyResponderaCategorias(HOTEL_COMPLETO);
  const r: any = await consultarPlanesTool.handler({ personas: 4, segmento: "familia", fecha: FECHA }, ctx);
  revisar(r.result?.modo !== "grupo", "4 personas sin más datos no entra en modo grupo", "4 personas entró en modo grupo");
  const r4a: any = await consultarPlanesTool.handler({ personas: 4, adultos: 4, ninos: 0, fecha: FECHA }, ctx);
  mostrar(r4a);
  revisar(r4a.result?.modo === "grupo" && r4a.result?.domos === 2, "4 ADULTOS sí: 1 familiar (3) + 1 pareja (1)", `4 adultos: modo=${r4a.result?.modo} domos=${r4a.result?.domos}`);
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Los grupos se arman con varios domos, familiares primero y parejas después.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
process.exit();
