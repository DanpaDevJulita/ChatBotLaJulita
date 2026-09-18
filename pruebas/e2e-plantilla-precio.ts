/**
 * PRUEBA: el token `$$$$` en la descripción de un plan se reemplaza por el precio REAL de la
 * base, sin borrar la línea completa (ni el emoji, ni el texto que la acompaña).
 *
 * [2026-09-13] Pedido de Daniel: el primer arreglo del precio-viejo-en-la-descripción (2026-09-11)
 * borraba de raíz cualquier línea que pareciera traer un precio — funcionaba, pero dejaba el
 * mensaje con un hueco feo (se perdía el emoji y la palabra de esa línea). La solución que pidió:
 * el equipo edita la plantilla y dónde iba el número pone literal `$$$$`; el bot lo cambia por el
 * precio de verdad de la columna que corresponda, según lo que ya dice esa misma línea ("entre
 * semana" / "fin de semana" / "puente").
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.LOBBYPMS_API_TOKEN ||= "";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const { consultarPlanesTool } = await import("../src/agentes/ventas/herramientas/planes.js");

const CTX = { channel: "whatsapp", externalId: "+573000000000" };

filasDe("planes").push({
  id: 999,
  nombre: "PLAN DE PRUEBA PLANTILLA",
  descripcion:
    "Bienvenida\r\n\r\n" +
    "💰 Entre semana (lunes a viernes): $$$$\r\n" +
    "💰 Fin de semana (sábado o domingo): $$$$\r\n" +
    "💰 Sábado o domingo puente festivo $$$$\r\n\r\n" +
    "🎁 Este plan trae un $$$$ de regalo que no corresponde a ningún precio cargado\r\n\r\n" +
    "Precio sin IVA",
  precio_entre_semana: 590000,
  precio_fin_de_semana: 760000,
  precio_fin_de_semana_puente: 0, // no aplica para este plan de prueba
  domos_id: [],
  activo: true,
});

let fallas = 0;

console.log("CASO 1. El detalle del plan reemplaza cada $$$$ por el precio real de su línea\n");
{
  const resultado = await consultarPlanesTool.handler({ plan: "PLAN DE PRUEBA PLANTILLA" }, CTX);
  const texto = resultado.reply_to_user ?? "";

  if (!/Entre semana \(lunes a viernes\): \$\s?590\.000/.test(texto)) {
    console.log("  ❌ la línea de 'entre semana' no trae el precio real ($590.000)");
    fallas++;
  } else {
    console.log("  ✅ 'entre semana' quedó con $590.000, con el emoji y el texto intactos");
  }

  if (!/Fin de semana \(s[aá]bado o domingo\): \$\s?760\.000/.test(texto)) {
    console.log("  ❌ la línea de 'fin de semana' no trae el precio real ($760.000)");
    fallas++;
  } else {
    console.log("  ✅ 'fin de semana' quedó con $760.000");
  }

  if (texto.includes("$$$$")) {
    console.log("  ❌ quedó un $$$$ SIN reemplazar en el mensaje final — nunca debe llegar así al cliente");
    fallas++;
  } else {
    console.log("  ✅ no quedó ningún $$$$ sin resolver en el mensaje final");
  }

  if (texto.includes("de regalo que no corresponde")) {
    console.log("  ❌ la línea con el $$$$ irresoluble (precio de puente en 0, sin palabra clave) no se quitó");
    fallas++;
  } else {
    console.log("  ✅ la línea con el $$$$ que no se pudo resolver a ningún precio se quitó, sin dejar basura");
  }
}

// [2026-09-17] Este caso probaba lo CONTRARIO hasta hoy: que una cifra escrita a mano en la
// descripción se borrara antes de llegar al cliente. Esa red de seguridad existía mientras
// quedaban planes sin migrar a `$$$$`, pero borraba por igual montos legítimos que no son el
// precio de ningún plan — el caso real es "bebidas de hasta $10.000" del PLAN DESCANSO PREMIUM,
// cuya línea entera desaparecía y el cliente nunca se enteraba de que la cena venía incluida.
//
// La regla la fijó Daniel el 2026-09-17: la base manda, el bot no opina sobre lo que haya ahí.
// Las descripciones se administran desde el panel, así que una cifra escrita en una es
// intencional. Lo que sigue prohibido es que el MODELO invente cifras, y de eso se encarga la
// verificación de runTurn.ts (ver pruebas/e2e-precio.ts), no este filtro.
console.log("\nCASO 2. Un monto escrito a mano en la descripción llega tal cual al cliente\n");
{
  filasDe("planes").push({
    id: 998,
    nombre: "PLAN CON TOPE DE CONSUMO",
    descripcion: "🍽️ Cena: dos platos fuertes y dos bebidas (bebidas de hasta $10.000)\r\n\r\nOtros detalles del plan.",
    precio_entre_semana: 590000,
    precio_fin_de_semana: 760000,
    precio_fin_de_semana_puente: 860000,
    domos_id: [],
    activo: true,
  });
  const resultado = await consultarPlanesTool.handler({ plan: "PLAN CON TOPE DE CONSUMO" }, CTX);
  const texto = resultado.reply_to_user ?? "";
  if (!texto.includes("10.000")) {
    console.log("  ❌ el monto de la descripción se perdió: el filtro viejo sigue borrando la línea");
    fallas++;
  } else if (!texto.includes("dos platos fuertes")) {
    console.log("  ❌ el monto llegó pero la línea quedó cortada");
    fallas++;
  } else {
    console.log("  ✅ el monto de la descripción llegó completo, con su línea intacta");
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Los $$$$ se resuelven bien y lo que está en la descripción llega tal cual.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
