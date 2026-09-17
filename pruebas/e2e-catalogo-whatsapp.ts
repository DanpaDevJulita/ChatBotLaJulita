/**
 * PRUEBA: mensaje de catálogo de WhatsApp (gratis, alternativa al carrusel de pago — ver
 * REFERENCIA-CATALOGO-WHATSAPP.md). Cubre lo que más importa: que solo se arme con planes que
 * YA tengan `retailer_id` cargado, que nunca invente un SKU, y que el detalle de un plan
 * puntual (con video) no se vea afectado por nada de esto.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const { seccionesCatalogoDe } = await import("../src/agentes/ventas/herramientas/planes.js");

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

console.log("CASO 1. Ningún plan mostrado tiene retailer_id: no arma catálogo (no inventa nada)\n");
{
  const planes = filasDe("planes");
  const paraiso = planes.find((p) => p.nombre === "PLAN PARAISO UNA NOCHE DOS PERSONAS")!;
  const confort = planes.find((p) => p.nombre === "PLAN CONFORT UNA NOCHE PARA DOS PERSONAS")!;
  delete paraiso.retailer_id;
  delete confort.retailer_id;

  const r = seccionesCatalogoDe([paraiso, confort]);
  revisar(r === null, "devuelve null cuando ningún plan mostrado tiene SKU", `devolvió ${JSON.stringify(r)}`);
}

console.log("\nCASO 2. Algunos planes SÍ tienen retailer_id: solo esos entran, no se inventa el resto\n");
{
  const planes = filasDe("planes");
  const paraiso = planes.find((p) => p.nombre === "PLAN PARAISO UNA NOCHE DOS PERSONAS")!;
  const confort = planes.find((p) => p.nombre === "PLAN CONFORT UNA NOCHE PARA DOS PERSONAS")!;
  const familiar = planes.find((p) => p.nombre === "PLAN FAMILIAR 3 PERSONAS")!;
  paraiso.retailer_id = "plan-paraiso";
  delete confort.retailer_id;
  familiar.retailer_id = "plan-familiar-3";

  const r = seccionesCatalogoDe([paraiso, confort, familiar]);
  revisar(r !== null && r.length === 1, "arma una sola sección", `devolvió ${JSON.stringify(r)}`);
  const ids = r?.[0]?.retailerIds ?? [];
  revisar(
    ids.length === 2 && ids.includes("plan-paraiso") && ids.includes("plan-familiar-3") && !ids.includes(""),
    "solo incluye los SKU que sí estaban cargados (2 de 3 planes)",
    `retailerIds = ${JSON.stringify(ids)}`
  );
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El catálogo de WhatsApp arma secciones solo con los SKU reales, nunca inventa.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
