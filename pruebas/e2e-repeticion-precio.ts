/**
 * PRUEBA: repreguntar por un precio que el bot YA consultó no puede terminar en
 * "dame un momento que confirmo con el equipo" — ni costar vueltas de más.
 *
 * [2026-09-13] Bug real (captura de WhatsApp + log de producción de Daniel): después de
 * cotizar bien el PLAN UNA PERSONA UNA NOCHE DOMO DELUXE ($5.000), el cliente preguntó
 * "que incluye y cual es su costo" y el bot respondió "Dame un momento que confirmo el valor
 * exacto con el equipo de La Julita".
 *
 * El log mostró las dos causas, las dos acá cubiertas:
 *
 *   1. La red de seguridad descartaba la respuesta del modelo apenas mencionaba plata sin haber
 *      llamado una herramienta en ESE hop — aunque la cifra YA estuviera verificada por una
 *      llamada anterior del MISMO turno. Eso costaba una vuelta extra al modelo (más lento) sin
 *      aportar nada. Ahora solo se revalida si hay alguna cifra todavía sin verificar.
 *
 *   2. Cuando sí hacía falta revalidar, el pipeline forzaba `tool_choice` y confiaba en que el
 *      modelo llamara la herramienta — y en el log real NO la llamó (el forzado se ve, la llamada
 *      no aparece). Sin dato fresco, el turno terminaba en el mensaje de respaldo. Ahora la
 *      revalidación la hace el pipeline directamente, con los argumentos que ya funcionaron en
 *      esa conversación, sin depender de que el modelo obedezca.
 */
process.env.FOLLOWUP_ENABLED = "false";
process.env.LOBBYPMS_API_TOKEN = "";
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";

import type { Guion } from "./fakes.js";
import { PLAN_PROBADO, PRECIO_REAL_ENTRE_SEMANA } from "./datos-reales.js";

const { instalarSupabaseFalso, instalarModeloFalso, usarGuion, adaptadorFalso, enviados, registroDelModelo } =
  await import("./fakes.js");

instalarSupabaseFalso();
instalarModeloFalso();

const { handleInbound } = await import("../src/core/pipeline/runTurn.js");

const PLAN = PLAN_PROBADO.nombre;
const PRECIO = String(PRECIO_REAL_ENTRE_SEMANA);

function montosEn(texto: string): string[] {
  const out: string[] = [];
  for (const re of [/\$\s?\d[\d.,]*/g, /\b\d{1,3}(?:[.,]\d{3})+\b/g]) {
    for (const m of texto.matchAll(re)) {
      const d = m[0].replace(/\D/g, "");
      if (d.length >= 4) out.push(d);
    }
  }
  return [...new Set(out)];
}

async function mensajeDelCliente(externalId: string, texto: string) {
  await handleInbound(
    { channel: "whatsapp", externalId, text: texto, timestamp: new Date().toISOString() },
    adaptadorFalso
  );
}

let fallas = 0;

console.log("CASO 1. Repetir una cifra YA verificada en este turno no cuesta una vuelta extra\n");
{
  const externalId = "+573000000101";
  enviados.length = 0;
  registroDelModelo.length = 0;

  // hop 1: el modelo consulta la base (queda verificado el precio real).
  // hop 2: redacta citando ESA misma cifra, sin volver a llamar la herramienta — antes esto se
  //        descartaba y se gastaba un hop más; ahora debe aceptarse tal cual.
  const guion: Guion = (_l, hop) => {
    if (hop === 1) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: "2026-09-15" } };
    return { texto: `El ${PLAN} te queda en *$ ${PRECIO}* para esa fecha 💚 ¿Lo dejamos apartado?` };
  };
  usarGuion(guion);

  await mensajeDelCliente(externalId, "cuanto vale el plan familiar el 15?");

  const texto = enviados.at(-1) ?? "";
  const hopsUsados = registroDelModelo.filter((l) => l.startsWith("hop ")).length;

  if (texto.includes("Dame un momento")) {
    console.log("  ❌ cayó al mensaje de respaldo con una cifra que YA estaba verificada este turno");
    fallas++;
  } else if (!montosEn(texto).includes(PRECIO)) {
    console.log(`  ❌ el mensaje final no trae el precio real (${PRECIO}): "${texto}"`);
    fallas++;
  } else {
    console.log(`  ✅ el cliente recibió el precio real tal cual lo redactó el modelo`);
  }

  if (hopsUsados > 2) {
    console.log(`  ❌ gastó ${hopsUsados} vueltas al modelo; con la cifra ya verificada debían bastar 2`);
    fallas++;
  } else {
    console.log(`  ✅ resolvió en ${hopsUsados} vueltas al modelo (sin revalidación innecesaria)`);
  }
}

console.log("\nCASO 2. El modelo contesta de memoria y NO obedece el tool_choice: el pipeline revalida solo\n");
{
  const externalId = "+573000000102";
  enviados.length = 0;

  // --- Turno 1: consulta normal, queda registrado con qué argumentos funcionó ---
  usarGuion((_l, hop) => {
    if (hop === 1) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: "2026-09-15" } };
    return { texto: `El ${PLAN} te queda en *$ ${PRECIO}* 💚` };
  });
  await mensajeDelCliente(externalId, "cuanto vale el plan familiar el 15?");

  // --- Turno 2: la repregunta. El modelo contesta de memoria y, aunque se le fuerce la
  //     herramienta, NUNCA la llama (exactamente lo que se vio en el log real). ---
  enviados.length = 0;
  registroDelModelo.length = 0;
  usarGuion(() => ({
    texto: `Claro 💚 El ${PLAN} incluye bienvenida, desayuno, jacuzzi y fogata, y vale *$ ${PRECIO}* sin IVA.`,
  }));

  await mensajeDelCliente(externalId, "que incluye y cual es su costo");

  const texto = enviados.at(-1) ?? "";
  if (texto.includes("Dame un momento")) {
    console.log("  ❌ el cliente recibió el mensaje de respaldo: la revalidación directa no funcionó");
    fallas++;
  } else if (!montosEn(texto).includes(PRECIO)) {
    console.log(`  ❌ el mensaje final no trae el precio real (${PRECIO}): "${texto}"`);
    fallas++;
  } else {
    console.log("  ✅ el pipeline revalidó contra la base por su cuenta y el cliente recibió la respuesta buena");
  }
}

console.log("\nCASO 3. Una cifra NUEVA, sin verificar, sigue sin poder pasar\n");
{
  const externalId = "+573000000103";
  enviados.length = 0;

  // Turno 1 para dejar argumentos recordados (el plan real, precio real).
  usarGuion((_l, hop) => {
    if (hop === 1) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: "2026-09-15" } };
    return { texto: `El ${PLAN} te queda en *$ ${PRECIO}* 💚` };
  });
  await mensajeDelCliente(externalId, "cuanto vale el plan familiar el 15?");

  // Turno 2: el modelo se inventa un descuento que no existe en ninguna parte de la base.
  enviados.length = 0;
  usarGuion(() => ({ texto: `Te lo dejo en *$ 2.500.000* si reservas hoy mismo 🎉` }));
  await mensajeDelCliente(externalId, "me haces un descuento?");

  const texto = enviados.at(-1) ?? "";
  if (montosEn(texto).includes("2500000")) {
    console.log("  ❌ ¡una cifra inventada llegó al cliente! La red de seguridad quedó rota");
    fallas++;
  } else {
    console.log("  ✅ la cifra inventada no llegó al cliente (la red de seguridad sigue intacta)");
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ 3/3. Repreguntar es rápido y correcto, y nada inventado pasa igual.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
