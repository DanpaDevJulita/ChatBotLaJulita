/**
 * PRUEBA: el saludo con el aviso de la política de datos es SIEMPRE el primer mensaje.
 *
 * El caso real (Daniel, 2026-09-18): hizo `/reset`, escribió "info" y lo primero que recibió fue
 * la explicación de que el valor varía según la fecha. El aviso de datos nunca salió. Su
 * reclamo: "¿por qué no envió mensaje de políticas? Eso es súper importante, y debe ser el
 * primer mensaje".
 *
 * La causa: el saludo era una instrucción del prompt, o sea una decisión del modelo. Ese turno
 * terminó en una herramienta con texto literal (`presentar_glamping`), y un texto literal ES el
 * mensaje del turno — así que el saludo no salió. Ahora lo manda el pipeline antes de atender el
 * primer mensaje (ver saludarSiEsElPrimerMensaje en core/pipeline/runTurn.ts).
 *
 * Es una regla legal, no de estilo: el aviso es lo que respalda toda la conversación que sigue.
 */
process.env.FOLLOWUP_ENABLED = "false";
process.env.LOBBYPMS_API_TOKEN = "";
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";

import type { Guion } from "./fakes.js";

const { instalarSupabaseFalso, instalarModeloFalso, usarGuion, enrutarSiempreA, adaptadorFalso, enviados, filasDe } =
  await import("./fakes.js");

instalarSupabaseFalso();
instalarModeloFalso();
enrutarSiempreA("informacion");

const { handleInbound } = await import("../src/core/pipeline/runTurn.js");
const { invalidarCachePoliticas } = await import("../src/core/db/politicasRepo.js");

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

async function escribe(externalId: string, texto: string) {
  await handleInbound(
    { channel: "whatsapp", externalId, text: texto, timestamp: new Date().toISOString() },
    adaptadorFalso
  );
}

// El modelo contesta cualquier cosa: lo que se mira es el mensaje que sale ANTES del suyo.
usarGuion((() => ({ texto: "¡Claro! Cuéntame la fecha y cuántas personas 💚" })) as Guion);

console.log("█".repeat(92));
console.log("  PRUEBA — el aviso de la política de datos abre toda conversación nueva");
console.log("█".repeat(92));

console.log("\nCASO 1. Cliente nuevo: el primer mensaje es el saludo con la política\n");
{
  const externalId = "+573000000901";
  enviados.length = 0;

  await escribe(externalId, "info");

  const primero = enviados[0] ?? "";
  revisar(enviados.length >= 2, "salieron el saludo y la respuesta", `salió ${enviados.length} mensaje(s): el cliente se quedó sin uno de los dos`);
  revisar(/pol[íi]tica de datos/i.test(primero), "el primer mensaje trae el aviso de la política de datos", `el primer mensaje no avisa nada de datos: "${primero}"`);
  revisar(
    primero.includes("https://lajulitaglamping.com.co/politica-de-privacidad/"),
    "el link va a la política exacta, no a la portada",
    `el link no es el de la política: "${primero}"`
  );
}

console.log("\nCASO 2. El segundo mensaje del mismo cliente NO vuelve a saludar\n");
{
  const externalId = "+573000000902";
  enviados.length = 0;
  await escribe(externalId, "hola");
  const cuantosAlPrincipio = enviados.length;

  enviados.length = 0;
  await escribe(externalId, "precios");

  revisar(
    !enviados.some((m) => /pol[íi]tica de datos/i.test(m)),
    "no repite el aviso en el mensaje siguiente",
    "volvió a mandar el saludo con la política, como si el cliente fuera nuevo otra vez"
  );
  revisar(cuantosAlPrincipio >= 2, "en el primer mensaje sí había salido", "el saludo no salió ni la primera vez");
}

console.log("\nCASO 3. El texto sale de la base cuando el equipo lo editó desde el panel\n");
{
  filasDe("politicas").push({
    clave: "saludo_bienvenida",
    titulo: "Saludo",
    contenido: "Hola 👋 Somos La Julita. Al continuar aceptas nuestra política de datos 👉 https://lajulitaglamping.com.co/politica-de-privacidad/",
    activo: true,
  });
  invalidarCachePoliticas();

  const externalId = "+573000000903";
  enviados.length = 0;
  await escribe(externalId, "hola");

  revisar(
    (enviados[0] ?? "").startsWith("Hola 👋 Somos La Julita."),
    "manda el texto que el equipo tiene cargado",
    `mandó otro texto: "${enviados[0]}"`
  );
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Nadie habla con el bot sin haber recibido primero el aviso de datos.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
