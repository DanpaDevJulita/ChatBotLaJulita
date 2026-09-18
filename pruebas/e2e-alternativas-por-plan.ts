/**
 * PRUEBA: cuando no hay cupo, las fechas alternativas se ofrecen con PLANES, no con domos.
 *
 * El caso real (Daniel, 2026-09-18): el cliente pidió para hoy, dos personas; no había cupo, y el
 * bot le contestó con una lista de fechas y NOMBRES DE DOMOS ("viernes 18: Domo Deluxe, Domo
 * Familiar"), que es lo que devuelve la API de LobbyPMS. El cliente hizo lo único razonable con
 * esa lista: preguntó "¿cuál es el domo deluxe?" — y ahí la conversación se torció hasta
 * terminar ofreciéndole a una pareja un plan de una persona.
 *
 * Daniel lo resumió así: "¿por qué le ofrece por domos y no por planes que sí tengan
 * disponibilidad?". El domo es donde duerme; lo que se vende, lo que tiene precio y lo que dice
 * para cuántos es, es el plan.
 *
 * Lo que defiende esta prueba:
 *   1. Que en el mensaje haya nombres de PLANES con precio, y ningún nombre de domo suelto.
 *   2. Que los planes ofrecidos le sirvan al grupo del cliente (una pareja no puede recibir el
 *      plan de una persona, que es justo como empezó el problema).
 *   3. Que una fecha con domos libres pero sin ningún plan vendible para ese grupo NO se ofrezca:
 *      antes salía igual y era una invitación a algo que después no se le podía vender.
 */
process.env.FOLLOWUP_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN = "prueba";

const { instalarSupabaseFalso, instalarLobbyFalso, lobbyResponderaCategorias } = await import("./fakes.js");
instalarSupabaseFalso();
instalarLobbyFalso();

const { consultarFechasAlternativasTool } = await import("../src/agentes/ventas/herramientas/disponibilidad.js");

const CTX = { channel: "whatsapp", externalId: "+573000000701" };
/** Un sábado, para que la tarifa de fin de semana exista en todos los planes de la foto. */
const FECHA = "2026-09-19";

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

console.log("█".repeat(92));
console.log("  PRUEBA — fechas alternativas: se ofrecen planes, no domos");
console.log("█".repeat(92));

console.log("\nCASO 1. Pareja: el mensaje trae planes con precio y ningún domo suelto\n");
{
  lobbyResponderaCategorias([
    { name: "DOMO ROMANTIC", available: 2 },
    { name: "DOMO DELUXE", available: 1 },
  ]);

  const r = await consultarFechasAlternativasTool.handler(
    { fecha: FECHA, personas: 2, segmento: "pareja" } as any,
    CTX as any
  );
  const texto = r.reply_to_user ?? "";
  const planes = (r.result as any)?.fechas?.[0]?.planes ?? [];

  revisar(
    !/domo\s+(deluxe|romantic|familiar|clasico)/i.test(texto),
    "no le ofrece ningún domo suelto",
    `el mensaje sigue nombrando domos: "${texto}"`
  );
  revisar(/\$\s?\d/.test(texto), "cada fecha va con su precio", "no le dice el precio de nada");
  revisar(planes.length > 0, "el resultado trae los planes vendibles de esa fecha", "el resultado no trae ningún plan");
  revisar(
    planes.every((p: any) => /DOS PERSONAS/i.test(p.nombre)),
    "todos los planes ofrecidos son para dos personas",
    `se colaron planes que no son de pareja: ${JSON.stringify(planes.map((p: any) => p.nombre))}`
  );
  revisar(
    !planes.some((p: any) => /UNA PERSONA/i.test(p.nombre)),
    "no aparece el plan de una persona",
    "apareció el plan de una persona, que es justo el error que se reportó"
  );
  revisar(
    !planes.some((p: any) => /DOS NOCHES/i.test(p.nombre)),
    "pidiendo 1 noche no le ofrece planes de dos noches",
    `ofreció un plan de dos noches para una sola: ${JSON.stringify(planes.map((p: any) => p.nombre))}`
  );
}

console.log("\nCASO 2. Los precios del mensaje son los de la base, no inventados\n");
{
  const r = await consultarFechasAlternativasTool.handler(
    { fecha: FECHA, personas: 2, segmento: "pareja" } as any,
    CTX as any
  );
  const texto = r.reply_to_user ?? "";
  const planes = (r.result as any)?.fechas?.[0]?.planes ?? [];
  const masBarato = Math.min(...planes.map((p: any) => p.precio));
  const formateado = new Intl.NumberFormat("es-CO").format(masBarato);

  revisar(
    texto.includes(formateado),
    `el "desde" es el plan más barato con cupo ($${formateado})`,
    `el "desde" no coincide con el plan más barato ($${formateado}): "${texto}"`
  );
}

console.log("\nCASO 3. Hay domos libres pero ninguno le sirve al grupo: no se ofrece la fecha\n");
{
  // Solo queda libre un domo de 2 personas y vienen 5: antes esta fecha se ofrecía igual, con el
  // nombre del domo, y el cliente elegía algo que no se le podía vender.
  lobbyResponderaCategorias([{ name: "DOMO ROMANTIC", available: 2 }]);

  const r = await consultarFechasAlternativasTool.handler({ fecha: FECHA, personas: 5 } as any, CTX as any);
  const texto = r.reply_to_user ?? "";

  revisar(
    /no me queda cupo/i.test(texto),
    "le dice con honestidad que no tiene para su grupo",
    `le ofreció algo igual: "${texto}"`
  );
  revisar((r.result as any)?.encontradas === 0, "no cuenta esa fecha como encontrada", "contó una fecha que no se le puede vender");
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Las fechas alternativas se ofrecen como planes vendibles a ese cliente.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
