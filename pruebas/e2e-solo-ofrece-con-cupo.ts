/**
 * PRUEBA: no se le ofrece al cliente nada que ya sabemos que NO tiene cupo.
 *
 * Regla de Daniel (2026-09-18), sobre dos conversaciones reales seguidas: "si ofreces algo es
 * porque sí tiene disponibilidad" y "si ya sabes cuántas personas y la fecha, debes mostrar
 * planes que estén disponibles para ese día".
 *
 * Las dos veces pasó lo mismo: el bot listó opciones con precio, el cliente eligió una, y recién
 * ahí le dijeron que esa no tenía cupo. El dato de cupo ya estaba consultado ANTES de armar esas
 * listas — simplemente no se usaba para filtrarlas.
 *
 * Lo que NO se filtra, y también se prueba acá: los planes cuyo cupo no se pudo confirmar (API
 * caída, o una categoría que no reconocemos). Esos siguen saliendo, porque el mensaje ya avisa
 * que el cupo lo confirma el equipo — descartarlos dejaría al cliente sin nada que ver cada vez
 * que LobbyPMS tiene un mal momento.
 */
process.env.FOLLOWUP_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN = "prueba";

const { instalarSupabaseFalso, instalarLobbyFalso, lobbyResponderaCategorias } = await import("./fakes.js");
instalarSupabaseFalso();
instalarLobbyFalso();

const { consultarPlanesTool } = await import("../src/agentes/ventas/herramientas/planes.js");

const CTX = { channel: "whatsapp", externalId: "+573000000801" };
/** Un viernes: todos los planes de pareja tienen tarifa de fin de semana. */
const FECHA = "2026-09-18";

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

console.log("█".repeat(92));
console.log("  PRUEBA — solo se ofrece lo que tiene cupo esa fecha");
console.log("█".repeat(92));

console.log("\nCASO 1. Sin cupo para parejas ese día: no se le arma el menú de experiencias\n");
{
  // Todo lleno de verdad. [2026-09-18 — ticket #6] Antes este caso dejaba el DOMO FAMILIAR libre
  // y esperaba un "no hay cupo": eso era lo que Sebas pidió cambiar ("si solo está el familiar,
  // se lo ofrezco igual a la pareja en plan básico"), así que ahora un domo más grande SÍ cuenta
  // y el escenario de "no hay nada" tiene que ser justamente ese, nada.
  lobbyResponderaCategorias([
    { name: "DOMO ROMANTIC", available: 0 },
    { name: "DOMO FAMILIAR", available: 0 },
    { name: "DOMO DELUXE", available: 0 },
    { name: "CHALET", available: 0 },
  ]);

  const r = await consultarPlanesTool.handler(
    { fecha: FECHA, personas: 2, segmento: "pareja" } as any,
    CTX as any
  );
  const texto = r.reply_to_user ?? "";

  revisar(
    (r.result as any)?.sin_cupo === true,
    "la herramienta avisa que esa fecha está sin cupo",
    `siguió ofreciendo opciones: "${texto.slice(0, 120)}..."`
  );
  revisar(
    !/Desde\s?\$/i.test(texto),
    "no le muestra ningún 'desde' de algo que no puede tomar",
    `le mostró precios de planes sin cupo: "${texto}"`
  );
  revisar(
    r.forzarSiguienteHerramienta === "consultar_fechas_alternativas",
    "encadena la búsqueda de otras fechas en el mismo turno",
    "no busca fechas alternativas: el cliente se queda esperando"
  );
}

console.log("\nCASO 1b. El Romantic lleno pero los Deluxe libres: la pareja SÍ tiene qué elegir\n");
{
  // El caso real del viernes 18/09 que reportó Daniel: "tengo libres todos los domos deluxe y un
  // familiar, ¿por qué no ofreció nada para pareja?". Los planes de pareja miraban SOLO el Domo
  // Romantic, porque `planes.domos_id` está en [1] para los 20 planes y eso los ata a "clásico".
  // Ahora un plan que no nombra ningún domo se puede alojar en cualquiera donde quepa el grupo.
  lobbyResponderaCategorias([
    { name: "DOMO ROMANTIC", available: 0 },
    { name: "DOMO DELUXE", available: 3 },
    { name: "DOMO FAMILIAR", available: 1 },
    { name: "CHALET", available: 0 },
  ]);

  const r = await consultarPlanesTool.handler(
    { fecha: FECHA, personas: 2, segmento: "pareja" } as any,
    CTX as any
  );
  const texto = r.reply_to_user ?? "";

  revisar(
    (r.result as any)?.sin_cupo !== true,
    "no dice que no hay cupo teniendo los Deluxe libres",
    "dejó al cliente sin nada aunque había domos libres donde caben los dos"
  );
  revisar(/Desde\s?\$/i.test(texto), "le arma el menú de experiencias", `no le ofreció nada: "${texto}"`);
}

console.log("\nCASO 1c. Solo queda el domo familiar: a la pareja se le ofrece igual (ticket #6)\n");
{
  // Pedido de Sebas en audio, 2026-09-17: "si una pareja pregunta por plan básico y solo está
  // disponible el domo familiar, lo puedo ofrecer para esa pareja en plan básico". Un domo de 4
  // recibe a dos personas; dejar de vender esa noche por no ofrecerlo es perder plata.
  lobbyResponderaCategorias([
    { name: "DOMO ROMANTIC", available: 0 },
    { name: "DOMO DELUXE", available: 0 },
    { name: "CHALET", available: 0 },
    { name: "DOMO FAMILIAR", available: 1 },
  ]);

  const r = await consultarPlanesTool.handler(
    { fecha: FECHA, personas: 2, segmento: "pareja" } as any,
    CTX as any
  );
  const texto = r.reply_to_user ?? "";

  revisar(
    (r.result as any)?.sin_cupo !== true,
    "con el familiar libre, la pareja sí tiene opciones",
    "dijo que no había cupo teniendo un domo donde caben los dos"
  );
  revisar(/Desde\s?\$/i.test(texto), "le arma el menú de experiencias", `no le ofreció nada: "${texto}"`);
}

console.log("\nCASO 2. Con cupo, el menú sale normal\n");
{
  lobbyResponderaCategorias([
    { name: "DOMO ROMANTIC", available: 2 },
    { name: "DOMO FAMILIAR", available: 2 },
  ]);

  const r = await consultarPlanesTool.handler(
    { fecha: FECHA, personas: 2, segmento: "pareja" } as any,
    CTX as any
  );
  const texto = r.reply_to_user ?? "";

  revisar((r.result as any)?.sin_cupo !== true, "no dice que no hay cupo cuando sí lo hay", "dijo que no había cupo habiéndolo");
  revisar(/\$\s?\d/.test(texto), "le muestra las opciones con su precio", `no le mostró ninguna opción: "${texto}"`);
}

console.log("\nCASO 3. Si el cupo no se puede confirmar, igual se le muestran las opciones\n");
{
  // LobbyPMS no responde: `disponibilidad` queda en null y no se filtra nada.
  const { lobbyResponderaDisponibilidad } = await import("./fakes.js");
  lobbyResponderaCategorias(null);
  lobbyResponderaDisponibilidad([null]);

  const r = await consultarPlanesTool.handler(
    { fecha: FECHA, personas: 2, segmento: "pareja" } as any,
    CTX as any
  );
  const texto = r.reply_to_user ?? "";

  revisar(
    (r.result as any)?.sin_cupo !== true,
    "no confunde 'no pude confirmar' con 'no hay cupo'",
    "trató una caída de LobbyPMS como si no hubiera disponibilidad"
  );
  revisar(/\$\s?\d/.test(texto), "el cliente igual ve opciones", `se quedó sin ver nada: "${texto}"`);
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Lo que se ofrece tiene cupo, y una caída de LobbyPMS no deja al cliente sin nada.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
