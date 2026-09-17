/**
 * PRUEBA: cuando el cliente pide el detalle de un plan puntual ("más información"), si ese plan
 * tiene un link de YouTube cargado (`planes.link_video`, ver sql/planes-link-video.sql), el bot
 * lo agrega al final del mensaje — la misma información, pero en video.
 *
 * Pedido de Daniel (2026-09-14): "que cuando el cliente pida mas información tambien se agregue
 * un link de youtube donde esta la misma información pero en un video" — es SOLO para el
 * detalle de un plan puntual (con `plan`), no para el menú de experiencias ni la lista de a 3.
 *
 * Si el plan NO tiene link cargado (el caso normal hoy, porque el equipo todavía no los ha
 * subido), el bot no debe inventar ni mencionar ningún link.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const { consultarPlanesTool } = await import("../src/agentes/ventas/herramientas/planes.js");

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

const ctx = { channel: "whatsapp", externalId: "+573001110099" } as any;
const LINK_DE_PRUEBA = "https://www.youtube.com/watch?v=prueba-plan-paraiso";

console.log("CASO 1. El plan tiene link_video cargado: el detalle lo incluye\n");
{
  const planes = filasDe("planes");
  const paraiso = planes.find((p) => p.nombre === "PLAN PARAISO UNA NOCHE DOS PERSONAS");
  if (!paraiso) throw new Error("Plan de prueba no encontrado (revisar datos-reales.ts)");
  paraiso.link_video = LINK_DE_PRUEBA;

  const r: any = await consultarPlanesTool.handler({ plan: "PARAISO" }, ctx);
  console.log(r.reply_to_user.split("\n").map((l: string) => `  | ${l}`).join("\n"));

  revisar(
    r.reply_to_user.includes(LINK_DE_PRUEBA),
    "el detalle del plan incluye el link de YouTube tal cual",
    "el link de YouTube no aparece en el mensaje"
  );
  revisar(
    r.result?.link_video === LINK_DE_PRUEBA,
    "el link también viaja en el result (por si el modelo redacta el mensaje)",
    `el result trae link_video=${JSON.stringify(r.result?.link_video)}`
  );
}

console.log("\nCASO 2. El plan NO tiene link_video cargado: no se menciona ningún link\n");
{
  const planes = filasDe("planes");
  const confort = planes.find((p) => p.nombre === "PLAN CONFORT UNA NOCHE PARA DOS PERSONAS");
  if (!confort) throw new Error("Plan de prueba no encontrado (revisar datos-reales.ts)");
  delete confort.link_video;

  const r: any = await consultarPlanesTool.handler({ plan: "CONFORT" }, ctx);
  console.log(r.reply_to_user.split("\n").map((l: string) => `  | ${l}`).join("\n"));

  revisar(
    !/youtube|video del plan/i.test(r.reply_to_user),
    "sin link cargado, el mensaje no inventa ningún video",
    "el mensaje menciona un video/link que nadie cargó"
  );
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El link de YouTube del plan sale cuando existe, y nunca se inventa.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
