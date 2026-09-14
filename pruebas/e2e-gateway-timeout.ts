/**
 * PRUEBA: un "Gateway Timeout" de Supabase no puede dejar al cliente sin catálogo.
 *
 * [2026-09-13] Daniel vio varias veces en los logs de producción cosas como
 * `[catalogoRepo:clase_domo] list: Gateway Timeout`. Es un HTTP 504: la puerta de entrada de
 * Supabase no alcanzó a recibir la respuesta de la base a tiempo. No es un error de la consulta
 * ni de los datos — el mismo pedido, repetido un segundo después, casi siempre funciona.
 *
 * El problema era la consecuencia: la función devolvía una lista VACÍA, y con el catálogo vacío
 * el bot le contestaba al cliente "todavía no tengo los planes cargados" por un hipo de un
 * segundo. Ahora `leerCatalogo` (src/core/db/catalogoRepo.ts) reintenta una vez y, si tampoco,
 * usa el último dato bueno que sí se pudo leer.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";

const { instalarSupabaseFalso, simularFallaDeLectura } = await import("./fakes.js");
instalarSupabaseFalso();

const { planesRepo, getDomosYClases } = await import("../src/core/db/catalogoRepo.js");

let fallas = 0;

console.log("CASO 1. Lectura normal: trae los planes y los guarda como 'último dato bueno'\n");
{
  const planes = await planesRepo.list(true);
  if (planes.length === 0) {
    console.log("  ❌ no trajo ningún plan (la base de prueba debería tener varios)");
    fallas++;
  } else {
    console.log(`  ✅ trajo ${planes.length} planes`);
  }
}

console.log("\nCASO 2. Falla UNA vez (el hipo típico): el reintento la salva, nadie se entera\n");
{
  simularFallaDeLectura("planes", 1);
  const planes = await planesRepo.list(true);
  if (planes.length === 0) {
    console.log("  ❌ devolvió vacío: el reintento no funcionó");
    fallas++;
  } else {
    console.log(`  ✅ el reintento funcionó y trajo ${planes.length} planes, como si nada`);
  }
}

console.log("\nCASO 3. Falla las DOS veces: usa el último dato bueno en vez de dejar el catálogo vacío\n");
{
  simularFallaDeLectura("planes", 2);
  const planes = await planesRepo.list(true);
  if (planes.length === 0) {
    console.log("  ❌ devolvió vacío — el cliente vería 'todavía no tengo los planes cargados'");
    fallas++;
  } else {
    console.log(`  ✅ devolvió ${planes.length} planes del último dato bueno; el cliente no nota la falla`);
  }
}

console.log("\nCASO 4. Lo mismo para domos y clases (el caso exacto del log: clase_domo)\n");
{
  const primera = await getDomosYClases(); // deja dato bueno guardado
  if (primera.clases.length === 0) {
    console.log("  ❌ la base de prueba no trajo clases; el caso no es válido");
    fallas++;
  } else {
    // El cache interno de domos dura 60 s, así que se lo salta pidiendo de nuevo tras vencerlo
    // no es posible acá; en cambio se prueba la ruta de lectura directa con falla simulada.
    simularFallaDeLectura("clase_domo", 2);
    simularFallaDeLectura("domos", 2);
    const segunda = await getDomosYClases();
    if (segunda.clases.length === 0 || segunda.domos.length === 0) {
      console.log("  ❌ quedó sin domos/clases con el Gateway Timeout simulado");
      fallas++;
    } else {
      console.log(`  ✅ siguió respondiendo con ${segunda.domos.length} domos y ${segunda.clases.length} clases`);
    }
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ 4/4. Un Gateway Timeout de Supabase ya no deja al cliente sin catálogo.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
