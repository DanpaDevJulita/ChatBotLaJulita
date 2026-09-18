/**
 * PRUEBA: reproduce el bug reportado por Daniel el 14/09 — el bot ofrecía el PLAN FAMILIAR con
 * precio, sin avisar que los domos familiares estaban bloqueados esa fecha.
 *
 * Antes del fix: cuando el segmento/personas dejaban ≤3 candidatos (la rama de "mostrar directo",
 * sin pasar por `nivel` ni por el detalle de un `plan` puntual), `consultar_planes` NUNCA
 * consultaba LobbyPMS — así que el domo familiar salía con precio y sin ningún aviso de cupo,
 * aunque estuviera lleno. Esta prueba fija ese escenario exacto.
 *
 * [2026-09-18] El caso 1 cambió de expectativa, y es a propósito. Hasta hoy el plan sin cupo se
 * mostraba igual, con un "sin cupo esa fecha" al lado; Daniel pidió que directamente no se
 * ofrezca ("si ofreces algo es porque sí tiene disponibilidad"), después de ver dos veces al
 * cliente elegir una opción de la lista y recibir un "esa no tiene cupo". Así que ahora lo que
 * se verifica es más fuerte: ese plan no aparece, y en su lugar el bot avisa y sale a buscar
 * fechas cercanas. El caso 2 (sí hay cupo) sigue igual.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";

const { instalarSupabaseFalso, instalarLobbyFalso, lobbyResponderaDisponibilidad } = await import("./fakes.js");
instalarSupabaseFalso();
instalarLobbyFalso();

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

console.log("CASO 1. Domo familiar SIN cupo esa fecha: el cliente pide plan familiar, 3 adultos\n");
{
  // Exactamente el escenario del pantallazo: "quiero mejor un plan familiar para el 19 de
  // septiembre" -> "3 adultos". Sin `nivel` elegido y sin pedir el detalle de un `plan` puntual
  // por nombre — la rama que antes se saltaba la consulta a LobbyPMS.
  lobbyResponderaDisponibilidad([0]); // domo familiar: 0 disponibles

  const r: any = await consultarPlanesTool.handler(
    { fecha: "2026-09-19", personas: 3, segmento: "familia" },
    ctx
  );

  console.log(r.reply_to_user.split("\n").map((l: string) => `  | ${l}`).join("\n"));

  revisar(
    !/PLAN FAMILIAR/i.test(r.reply_to_user),
    "el plan familiar no se le ofrece esa fecha",
    "le ofreció el plan familiar teniendo los domos llenos (bug reproducido)"
  );
  revisar(
    r.result?.sin_cupo === true,
    "la herramienta avisa que esa fecha no tiene cupo para ese grupo",
    "no avisó que la fecha estaba sin cupo"
  );
  revisar(
    r.forzarSiguienteHerramienta === "consultar_fechas_alternativas",
    "sale a buscar fechas cercanas en el mismo turno",
    "dejó al cliente sin alternativa"
  );
  revisar(
    !/le pido al equipo que te confirme el cupo/i.test(r.reply_to_user),
    "el cierre no repite \"le pido al equipo que confirme el cupo\" (ya se consultó el cupo real)",
    "el cierre sigue diciendo que hay que confirmar cupo con el equipo, siendo que ya se consultó"
  );
}

console.log("\nCASO 2. Mismo pedido, pero SÍ hay cupo: no debe decir \"sin cupo\"\n");
{
  lobbyResponderaDisponibilidad([3]); // domo familiar: 3 disponibles

  const r: any = await consultarPlanesTool.handler(
    { fecha: "2026-09-20", personas: 3, segmento: "familia" },
    ctx
  );

  console.log(r.reply_to_user.split("\n").map((l: string) => `  | ${l}`).join("\n"));

  revisar(
    !/sin cupo esa fecha/i.test(r.reply_to_user),
    "con cupo real, no aparece el aviso de \"sin cupo\"",
    "aparece \"sin cupo\" aunque sí había disponibilidad"
  );
  revisar(
    /cupo: s[ií]/i.test(r.reply_to_user),
    "aparece el aviso positivo de cupo",
    "no aparece ningún aviso positivo de cupo"
  );
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El plan familiar ya avisa cupo real, no lo oferta a ciegas.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
