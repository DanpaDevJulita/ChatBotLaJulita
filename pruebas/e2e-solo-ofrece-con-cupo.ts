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
  // El domo de 2 personas está lleno; solo queda uno de 4, que no es de este segmento.
  lobbyResponderaCategorias([
    { name: "DOMO ROMANTIC", available: 0 },
    { name: "DOMO FAMILIAR", available: 2 },
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
