/**
 * PRUEBA: `presentar_glamping` — la respuesta a "solo quiero precios".
 *
 * Qué defiende: el caso real que reportó un vendedor el 2026-09-17. El cliente escribió "Solo
 * quiero precios" sin decir fecha ni cuántas personas, y el bot le contestó con el menú de las
 * tres experiencias y tres cifras. Lo que hay que mandarle es el mensaje que explica de qué
 * depende el valor, para después pedirle la fecha y cuántas personas son.
 *
 * [2026-09-17, segunda vuelta — ticket #5 del panel] La primera versión de la corrección seguía
 * mandando dos "desde" (la noche más económica de cada tarifa). Daniel la probó en vivo, le salió
 * "Entre semana desde $ 3.000" — el precio real del plan más barato que hay cargado — y pidió
 * sacar las cifras: el texto quedó en una sola frase, sin ningún número.
 *
 * Por eso esta prueba mira DOS cosas distintas:
 *   1. Que el texto cargado salga tal cual y que la herramienta no agregue ninguna cifra por su
 *      cuenta — ni en el mensaje ni en los datos crudos, porque publicar un "desde" ahí lo
 *      habilitaría para que el modelo lo escriba en el mensaje siguiente (ver `montosEn` en
 *      src/core/pipeline/runTurn.ts).
 *   2. Que el soporte de `$$$$` siga funcionando, porque el texto se edita desde el panel: el día
 *      que alguien vuelva a poner un precio, tiene que salir de la base y no escrito a mano (que
 *      es el bug del 2026-09-11, ver REGLA-DESCRIPCIONES-PRECIOS.md).
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const { presentarGlampingTool } = await import("../src/agentes/ventas/herramientas/presentacion.js");
const { invalidarCachePoliticas } = await import("../src/core/db/politicasRepo.js");
const { PLANES } = await import("./datos-reales.js");
const { tipoDePlan } = await import("../src/agentes/ventas/herramientas/planes.js");

const CTX = { channel: "whatsapp", externalId: "+573000000000" };

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

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

/** El mismo cálculo que hace la herramienta, hecho acá sobre los datos de la foto de la base. */
function nocheMasEconomica(tarifa: "entre_semana" | "fin_de_semana"): number {
  return Math.min(
    ...PLANES.filter((p) => tipoDePlan(p) !== "pasadia")
      .map((p) => (tarifa === "entre_semana" ? p.precio_entre_semana : p.precio_fin_de_semana))
      .filter((v) => v > 0)
  );
}

/** Deja una sola fila de `presentacion_general` con este contenido. */
function cargarPresentacion(contenido: string) {
  const filas = filasDe("politicas");
  const i = filas.findIndex((f: any) => f.clave === "presentacion_general");
  if (i >= 0) filas.splice(i, 1);
  filas.push({ clave: "presentacion_general", titulo: "Presentación", contenido, activo: true });
  invalidarCachePoliticas();
}

/** El texto que Daniel pidió el 2026-09-17, igual al que quedó cargado en la base. */
const TEXTO_OFICIAL =
  "💫 El valor de tu experiencia varía según la fecha exacta de tu visita 📅, las personas que " +
  "te acompañen 👥 y el plan que disfrutes 🌿🥂 (descanso o celebración en fechas especiales).";

console.log("█".repeat(92));
console.log("  PRUEBA — presentar_glamping: 'solo quiero precios' sin fecha ni personas");
console.log("█".repeat(92));

console.log("\nCASO 1. El texto oficial sale tal cual y SIN ninguna cifra\n");
{
  cargarPresentacion(TEXTO_OFICIAL);

  const r = await presentarGlampingTool.handler({}, CTX);
  const texto = r.reply_to_user ?? "";

  revisar(texto === TEXTO_OFICIAL, "sale exactamente el texto cargado en la base", `el texto salió cambiado:\n"${texto}"`);
  revisar(
    montosEn(texto).length === 0,
    "no le llega ninguna cifra de dinero",
    `se coló una cifra en el mensaje: ${JSON.stringify(montosEn(texto))} — es justo lo que se pidió sacar`
  );
  revisar(/fecha/i.test(texto), "le dice que el valor depende de la fecha", "no menciona la fecha");
  revisar(/personas/i.test(texto), "le dice que depende de cuántas personas son", "no menciona las personas");
}

console.log("\nCASO 2. Los datos crudos tampoco publican un precio\n");
{
  // Si el `result` trajera los "desde", esas cifras quedarían habilitadas para la verificación de
  // runTurn.ts y el modelo podría escribirlas en el mensaje siguiente — el mismo precio que el
  // equipo pidió dejar de mandar, colado por la puerta de atrás.
  const r = await presentarGlampingTool.handler({}, CTX);
  const crudo = JSON.stringify(r.result ?? {});
  revisar(
    montosEn(crudo).length === 0,
    "el result no habilita ningún monto",
    `el result publica cifras (${JSON.stringify(montosEn(crudo))}): el modelo las podría escribir en el próximo mensaje`
  );
}

console.log("\nCASO 3. Si el equipo vuelve a poner un precio, va como $$$$ y sale de la base\n");
{
  // El texto se edita desde el panel: el soporte del token tiene que seguir vivo para que una
  // cifra nueva no se escriba nunca a mano (bug del 2026-09-11).
  cargarPresentacion(
    ["🌿 Entre semana desde $$$$", "✨ Fin de semana desde $$$$", "", "📲 Cuéntame la fecha y cuántas personas vienen 💚"].join("\n")
  );

  const r = await presentarGlampingTool.handler({}, CTX);
  const texto = r.reply_to_user ?? "";

  revisar(!texto.includes("$$$$"), "no quedó ningún $$$$ sin resolver", "quedó un $$$$ crudo: eso le llegaría así al cliente");

  const esperadoES = nocheMasEconomica("entre_semana");
  const esperadoFS = nocheMasEconomica("fin_de_semana");
  const montos = montosEn(texto);
  revisar(montos.includes(String(esperadoES)), `el 'desde' de entre semana es $${esperadoES}`, `se esperaba $${esperadoES} de entre semana y llegó ${JSON.stringify(montos)}`);
  revisar(montos.includes(String(esperadoFS)), `el 'desde' de fin de semana es $${esperadoFS}`, `se esperaba $${esperadoFS} de fin de semana y llegó ${JSON.stringify(montos)}`);
  revisar(montos.length === 2, "solo esas dos cifras, nada más", `llegaron ${montos.length} cifras: ${JSON.stringify(montos)}`);

  // Un pasadía arranca más barato que varias noches. Si se colara en el cálculo, el mensaje
  // mostraría un precio que el cliente no puede tomar para dormir.
  const pasadiaMasBarato = Math.min(
    ...PLANES.filter((p) => tipoDePlan(p) === "pasadia")
      .map((p) => Math.min(...[p.precio_entre_semana, p.precio_fin_de_semana].filter((v) => v > 0)))
  );
  const esTambienNoche = PLANES.some(
    (p) => tipoDePlan(p) !== "pasadia" && [p.precio_entre_semana, p.precio_fin_de_semana].includes(pasadiaMasBarato)
  );
  revisar(
    esTambienNoche || !montos.includes(String(pasadiaMasBarato)),
    `el pasadía de $${pasadiaMasBarato} no se usó como 'desde' de una noche`,
    `se coló el precio de un pasadía ($${pasadiaMasBarato}) como si fuera una noche`
  );
}

console.log("\nCASO 4. Sin la presentación cargada, igual explica de qué depende el precio\n");
{
  const filas = filasDe("politicas");
  const i = filas.findIndex((f: any) => f.clave === "presentacion_general");
  if (i >= 0) filas.splice(i, 1);
  invalidarCachePoliticas();

  const r = await presentarGlampingTool.handler({}, CTX);
  const texto = r.reply_to_user ?? "";

  // Sin texto en la base NO se inventa una presentación con precios: se explica y se piden los
  // datos. Es la misma regla de politicasRepo — un texto de respaldo en el código es el que
  // termina quedando viejo.
  revisar(montosEn(texto).length === 0, "no inventa ningún precio cuando la base no tiene el texto", "mandó una cifra sin tener la presentación cargada");
  revisar(/fecha/i.test(texto) && /personas/i.test(texto), "igual pide la fecha y cuántas personas son", "no pide los datos que hacen falta");
  revisar(/cambia|depende|var[íi]a/i.test(texto), "explica que el valor depende de esos datos", "no explica de qué depende el precio");
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ La presentación sale sin cifras y el token sigue resolviéndose desde la base.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
