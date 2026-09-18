/**
 * PRUEBA: el viernes se cobra con la tarifa de ENTRE SEMANA.
 *
 * Ticket #7 del panel, reportado por Sebas en audio el 2026-09-17 y aprobado por Daniel el
 * 2026-09-18: "el precio de los viernes en todos los planes debería tener el mismo precio entre
 * semana". Hasta ese día el viernes entraba en la tarifa de fin de semana — un PLAN BASICO le
 * salía al cliente en $ 690.000 en vez de $ 569.000.
 *
 * Es un cambio que toca lo que se le cobra a la gente, así que esta prueba lo fija por los dos
 * lados: qué tarifa devuelve cada día de la semana, y que el precio que termina en el mensaje
 * sea de verdad el de entre semana.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.LOBBYPMS_API_TOKEN ||= "";

const { instalarSupabaseFalso } = await import("./fakes.js");
instalarSupabaseFalso();

const { tarifaDeFecha, consultarPlanesTool, esFinDeSemana } = await import(
  "../src/agentes/ventas/herramientas/planes.js"
);
const { PLANES } = await import("./datos-reales.js");

// Semana del 21 al 27 de septiembre de 2026: lunes 21 ... domingo 27.
const LUNES = "2026-09-21";
const JUEVES = "2026-09-24";
const VIERNES = "2026-09-25";
const SABADO = "2026-09-26";
const DOMINGO = "2026-09-27";

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

console.log("█".repeat(92));
console.log("  PRUEBA — el viernes se cobra como entre semana (ticket #7)");
console.log("█".repeat(92));

console.log("\nCASO 1. Qué tarifa le toca a cada día\n");
{
  revisar(tarifaDeFecha(VIERNES) === "entre_semana", "el viernes cobra tarifa de entre semana", `el viernes devolvió "${tarifaDeFecha(VIERNES)}"`);
  revisar(tarifaDeFecha(LUNES) === "entre_semana", "el lunes sigue en entre semana", `el lunes devolvió "${tarifaDeFecha(LUNES)}"`);
  revisar(tarifaDeFecha(JUEVES) === "entre_semana", "el jueves sigue en entre semana", `el jueves devolvió "${tarifaDeFecha(JUEVES)}"`);
  revisar(tarifaDeFecha(SABADO) === "fin_de_semana", "el sábado sigue en fin de semana", `el sábado devolvió "${tarifaDeFecha(SABADO)}"`);
  revisar(tarifaDeFecha(DOMINGO) === "fin_de_semana", "el domingo sigue en fin de semana", `el domingo devolvió "${tarifaDeFecha(DOMINGO)}"`);
}

console.log("\nCASO 2. Un puente festivo se sigue cobrando como puente, caiga el día que caiga\n");
{
  // El cliente lo aclara y el modelo pasa `festivo: true`. Esos días el glamping se llena igual
  // que un sábado, así que la regla del viernes no los toca.
  revisar(
    tarifaDeFecha(VIERNES, true) === "fin_de_semana_puente",
    "un viernes de puente cobra tarifa de puente",
    `un viernes de puente devolvió "${tarifaDeFecha(VIERNES, true)}"`
  );
}

console.log("\nCASO 3. El viernes sigue contando como día de alta ocupación\n");
{
  // `esFinDeSemana` responde otra pregunta: cuándo se llena el glamping (la usa
  // disponibilidad.ts para no ofrecerle esos días a una persona sola). El precio cambió, la
  // ocupación no.
  revisar(esFinDeSemana(VIERNES) === true, "el viernes sigue siendo día de fin de semana para la ocupación", "el viernes dejó de contar como día lleno");
}

console.log("\nCASO 4. El precio que le llega al cliente un viernes es el de entre semana\n");
{
  const basico = PLANES.find((p) => p.nombre === "PLAN BASICO UNA NOCHE PARA DOS PERSONAS")!;
  const r = await consultarPlanesTool.handler(
    { plan: "PLAN BASICO UNA NOCHE PARA DOS PERSONAS", fecha: VIERNES, personas: 2 } as any,
    { channel: "whatsapp", externalId: "+573000000601" } as any
  );
  const texto = r.reply_to_user ?? "";
  const esperado = new Intl.NumberFormat("es-CO").format(basico.precio_entre_semana);
  const viejo = new Intl.NumberFormat("es-CO").format(basico.precio_fin_de_semana);

  revisar(texto.includes(esperado), `cotiza $${esperado} (entre semana)`, `no cotizó el precio de entre semana: "${texto.split("\n")[1]}"`);
  revisar(!texto.includes(viejo), `ya no cotiza $${viejo} (el de fin de semana)`, `siguió cobrando el precio de fin de semana ($${viejo})`);
  revisar(/lunes a viernes/i.test(texto), "la etiqueta dice 'de lunes a viernes'", `la etiqueta quedó desactualizada: "${texto.split("\n")[1]}"`);
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El viernes se cobra como entre semana y el puente sigue siendo puente.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
