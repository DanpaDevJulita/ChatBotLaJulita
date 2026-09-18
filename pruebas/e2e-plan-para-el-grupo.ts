/**
 * PRUEBA: un plan donde el grupo NO cabe no se le puede mostrar como si fuera la respuesta.
 *
 * El caso real (Daniel, 2026-09-18): el cliente escribió "para hoy, dos personas", el bot cotizó
 * bien para dos y le listó las fechas libres nombrando los domos ("Chalet, Domo Romantic, Domo
 * Deluxe, Domo Familiar"). El cliente preguntó entonces "¿cuál es el domo deluxe?" — y le llegó
 * *PLAN UNA PERSONA UNA NOCHE DOMO DELUXE (hasta 1 persona)*, con precio y video, a una pareja.
 *
 * Eran dos fallas encadenadas, y esta prueba cubre las dos:
 *   1. La búsqueda por nombre de `consultar_planes` filtraba SOLO por nombre: `personas` y
 *      `segmento` no se miraban, aunque el cliente ya los hubiera dicho.
 *   2. En esa llamada el modelo mandó solo `plan: "domo deluxe"`, sin repetir `personas` — así
 *      que aunque el filtro existiera, la herramienta no habría tenido con qué filtrar. El
 *      pipeline ahora completa el grupo con el de la última consulta de la conversación
 *      (ver completarGrupoDeLaConversacion en core/pipeline/runTurn.ts).
 */
process.env.FOLLOWUP_ENABLED = "false";
process.env.LOBBYPMS_API_TOKEN = "";
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";

import type { Guion } from "./fakes.js";

const { instalarSupabaseFalso, instalarModeloFalso, usarGuion, enrutarSiempreA, adaptadorFalso, enviados } =
  await import("./fakes.js");

instalarSupabaseFalso();
instalarModeloFalso();
enrutarSiempreA("informacion");

const { consultarPlanesTool } = await import("../src/agentes/ventas/herramientas/planes.js");
const { handleInbound } = await import("../src/core/pipeline/runTurn.js");

const CTX = { channel: "whatsapp", externalId: "+573000000501" };

/** El plan que no debe llegarle a una pareja, y su precio de fin de semana. */
const PLAN_DE_UNA_PERSONA = "PLAN UNA PERSONA UNA NOCHE DOMO DELUXE";
const PRECIO_DE_ESE_PLAN = "1.090.000";

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

console.log("█".repeat(92));
console.log("  PRUEBA — 'cuál es el domo deluxe?' siendo dos: no puede llegar un plan de 1 persona");
console.log("█".repeat(92));

console.log("\nCASO 1. Pareja preguntando por el domo deluxe\n");
{
  const r = await consultarPlanesTool.handler({ plan: "domo deluxe", personas: 2 } as any, CTX as any);
  const texto = r.reply_to_user ?? "";

  revisar(
    !texto.includes(PLAN_DE_UNA_PERSONA),
    "no le ofrece el plan de una persona",
    `le ofreció "${PLAN_DE_UNA_PERSONA}" a una pareja`
  );
  revisar(
    !texto.includes(PRECIO_DE_ESE_PLAN),
    "no le cotiza el precio de ese plan",
    `le cotizó $${PRECIO_DE_ESE_PLAN}, que es de un plan donde no caben los dos`
  );
  revisar(
    /solo para 1 persona|no les sirve/i.test(texto),
    "le explica que ese plan es para una sola persona",
    "no le explica por qué no le sirve"
  );
  revisar(
    /DOS PERSONAS/i.test(texto),
    "le ofrece planes en los que sí caben los dos",
    "no le ofrece ninguna alternativa para dos personas"
  );
}

console.log("\nCASO 2. La misma pregunta, pero viajando solo: ahí el plan SÍ es el suyo\n");
{
  // Lo que defiende este caso: que el filtro no haya escondido el plan para todo el mundo.
  const r = await consultarPlanesTool.handler({ plan: "domo deluxe", personas: 1 } as any, CTX as any);
  const texto = r.reply_to_user ?? "";
  revisar(texto.includes(PLAN_DE_UNA_PERSONA), "le llega el plan que pidió", "no le llegó el plan de una persona a quien sí viaja solo");
}

console.log("\nCASO 3. El modelo no repite `personas`: el pipeline lo completa igual\n");
{
  // Reproduce la conversación real: primero cotiza para dos, después pregunta por el domo y el
  // modelo llama la herramienta SIN volver a decir para cuántos es.
  const externalId = "+573000000502";

  const guion: Guion = (_l, hop) => {
    if (hop === 1) return { herramienta: "consultar_planes", args: { personas: 2, segmento: "pareja" } };
    return { texto: "¿Te cuento de alguno? 💚" };
  };
  usarGuion(guion);
  enviados.length = 0;
  await handleInbound(
    { channel: "whatsapp", externalId, text: "para hoy, dos personas", timestamp: new Date().toISOString() },
    adaptadorFalso
  );

  // Segundo turno: el modelo pregunta por el plan SIN pasar personas — como pasó de verdad.
  const guion2: Guion = (_l, hop) => {
    if (hop === 1) return { herramienta: "consultar_planes", args: { plan: "domo deluxe" } };
    return { texto: "¿Te cuento de alguno? 💚" };
  };
  usarGuion(guion2);
  enviados.length = 0;
  await handleInbound(
    { channel: "whatsapp", externalId, text: "cual es el domo deluxe?", timestamp: new Date().toISOString() },
    adaptadorFalso
  );

  const ultimo = enviados.at(-1) ?? "";
  revisar(
    !ultimo.includes(PLAN_DE_UNA_PERSONA),
    "el pipeline recordó que son dos y no dejó pasar el plan de una persona",
    `le llegó igual "${PLAN_DE_UNA_PERSONA}" — el grupo no se heredó de la consulta anterior`
  );
  revisar(
    !ultimo.includes(PRECIO_DE_ESE_PLAN),
    "tampoco le llegó el precio de ese plan",
    `le llegó $${PRECIO_DE_ESE_PLAN} en el mensaje: "${ultimo.slice(0, 120)}..."`
  );
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Un plan solo se ofrece si el grupo del cliente cabe en él.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
