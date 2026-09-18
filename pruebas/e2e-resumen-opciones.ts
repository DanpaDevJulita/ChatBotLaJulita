/**
 * PRUEBA: `resumir_opciones` — el resumen de varias fechas en un solo mensaje.
 *
 * Qué defiende: el escenario D05 de la simulación del 2026-09-15, donde el cliente preguntó por
 * dos fechas en el mismo mensaje y recibió 8 cifras de dinero sueltas, sin forma de saber cuál
 * precio iba con cuál fecha. La herramienta responde con UNA LÍNEA POR FECHA y deja que el
 * cliente elija sobre cuál profundizar.
 *
 * Sin red: usa el Supabase y el LobbyPMS falsos de ./fakes.ts. OJO con esto último — no alcanza
 * con dejar LOBBYPMS_API_TOKEN vacío: cuando la API oficial no está, `consultarDisponibilidad`
 * cae al motor público, que SÍ sale a internet. La primera versión de esta prueba se escribió así
 * y "pasaba" consultando el hotel de verdad, con resultados distintos según el día.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";

const { instalarSupabaseFalso, instalarLobbyFalso, lobbyResponderaDisponibilidad, lobbyResponderaCategorias } = await import("./fakes.js");
instalarSupabaseFalso();
instalarLobbyFalso();

const { resumirOpcionesTool } = await import("../src/agentes/ventas/herramientas/resumenOpciones.js");
const { PLANES } = await import("./datos-reales.js");
const { segmentoDePlan } = await import("../src/agentes/ventas/herramientas/planes.js");

const CTX = { channel: "whatsapp", externalId: "+573000000000" };

/** Cifras de dinero de un texto, con el MISMO detector que usa el pipeline. */
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

console.log("█".repeat(92));
console.log("  PRUEBA — resumir_opciones: varias fechas en un mensaje, sin abrumar al cliente");
console.log("█".repeat(92));

// Un miércoles (entre semana) y un sábado (fin de semana): tarifas distintas a propósito.
const ENTRE_SEMANA = "2026-09-30";
const FIN_DE_SEMANA = "2026-10-03";

console.log("\nCASO 1. Dos fechas para el mismo segmento: una línea por fecha, no un menú por fecha\n");
{
  const r = await resumirOpcionesTool.handler(
    { nombre_cliente: "Daniel", consultas: [{ fecha: ENTRE_SEMANA, segmento: "pareja" }, { fecha: FIN_DE_SEMANA, segmento: "pareja" }] },
    CTX
  );
  const texto = r.reply_to_user ?? "";

  const lineasDeFecha = texto.split("\n").filter((l) => l.trim().startsWith("📆"));
  revisar(lineasDeFecha.length === 2, "salió exactamente una línea por fecha", `salieron ${lineasDeFecha.length} líneas de fecha, se esperaban 2`);

  // Lo central del hallazgo D05: que no se le vayan 8 cifras encima. Una por fecha es el tope.
  const montos = montosEn(texto);
  revisar(montos.length <= 2, `el mensaje trae ${montos.length} cifra(s), una por fecha`, `el mensaje trae ${montos.length} cifras: sigue siendo una pared de precios`);

  revisar(texto.includes("Daniel"), "saluda al cliente por su nombre", "no usó el nombre del cliente");
  revisar(/\?/.test(texto), "cierra con una pregunta para que el cliente elija", "no cierra preguntando nada");
}

console.log("\nCASO 2. El precio 'desde' es el MÁS BARATO que aplica a esa fecha, salido de la base\n");
{
  const r = await resumirOpcionesTool.handler({ consultas: [{ fecha: ENTRE_SEMANA, segmento: "pareja" }] }, CTX);
  const texto = r.reply_to_user ?? "";

  // El mínimo esperado se calcula acá con los mismos datos de la base, sin copiar ningún número
  // a mano: si mañana cambia un precio en la foto, la prueba sigue siendo válida.
  const esperado = Math.min(
    ...PLANES.filter((p) => segmentoDePlan(p) === "pareja")
      .map((p) => p.precio_entre_semana)
      .filter((v) => v > 0)
  );
  const montos = montosEn(texto);
  revisar(montos.includes(String(esperado)), `el 'desde' es $${esperado}, el plan más barato de esa fecha`, `se esperaba $${esperado} y llegó ${JSON.stringify(montos)}`);
  revisar(texto.includes("desde"), "dice 'desde' porque hay varios planes para elegir", "no dice 'desde' habiendo varios planes");
}

console.log("\nCASO 3. Con LobbyPMS sin responder, no se inventa un sí ni un no de cupo\n");
{
  // La API oficial responde 403 y el motor público (respaldo) no trae nada: es el caso real de
  // `ip_no_autorizada`, que en esta instalación pasa cada vez que cambia la IP de salida.
  lobbyResponderaDisponibilidad([null]);
  const r = await resumirOpcionesTool.handler({ consultas: [{ fecha: ENTRE_SEMANA, segmento: "familia" }] }, CTX);
  const texto = r.reply_to_user ?? "";

  revisar(!/con cupo|sin cupo/.test(texto), "no afirma nada sobre el cupo cuando no lo pudo confirmar", "afirmó algo del cupo sin poder confirmarlo");
  revisar(
    /verifique la disponibilidad/i.test(texto),
    "el cierre ofrece verificar la disponibilidad, que es justo lo que falta",
    "el cierre no se adapta: no ofrece verificar disponibilidad"
  );
  lobbyResponderaDisponibilidad([5]);
}

console.log("\nCASO 3b. Con cupo real confirmado, la línea lo dice y el cierre invita a avanzar\n");
{
  // "DOMO ROMANTIC" es el clásico de 2 personas en LobbyPMS: el alojamiento de los planes de pareja.
  lobbyResponderaCategorias([{ name: "DOMO ROMANTIC", available: 3 }]);
  const r = await resumirOpcionesTool.handler({ consultas: [{ fecha: ENTRE_SEMANA, segmento: "pareja" }] }, CTX);
  const texto = r.reply_to_user ?? "";
  revisar(/con cupo/.test(texto), "la línea avisa que esa fecha tiene cupo", "no dijo que había cupo teniéndolo confirmado");
  revisar(/amplíe la información/i.test(texto), "el cierre invita a elegir una y seguir", "el cierre no invita a avanzar");

  lobbyResponderaCategorias([{ name: "DOMO ROMANTIC", available: 0 }]);
  const sinCupo = await resumirOpcionesTool.handler({ consultas: [{ fecha: ENTRE_SEMANA, segmento: "pareja" }] }, CTX);
  const textoSinCupo = sinCupo.reply_to_user ?? "";
  revisar(/sin cupo/.test(textoSinCupo), "sin cupo, la línea lo dice", "no avisó que no había cupo");
  revisar(/días cercanos/i.test(textoSinCupo), "el cierre propone mirar días cercanos", "el cierre no propone otras fechas cuando no hay cupo");
  lobbyResponderaCategorias(null);
}

console.log("\nCASO 4. Sin fechas válidas no revienta: pregunta de nuevo\n");
{
  const r = await resumirOpcionesTool.handler({ consultas: [{ fecha: "el finde que viene" } as never] }, CTX);
  const texto = r.reply_to_user ?? "";
  revisar(texto.length > 0 && montosEn(texto).length === 0, "responde pidiendo las fechas, sin cifras inventadas", "devolvió algo raro con una fecha inválida");
}

console.log("\nCASO 5. Máximo 4 fechas listadas, y al cliente se le pide que priorice el resto\n");
{
  const muchas = Array.from({ length: 10 }, (_, i) => ({ fecha: `2026-10-${String(i + 1).padStart(2, "0")}`, segmento: "pareja" as const }));
  const r = await resumirOpcionesTool.handler({ consultas: muchas }, CTX);
  const texto = r.reply_to_user ?? "";
  const lineas = texto.split("\n").filter((l) => l.trim().startsWith("📆"));

  revisar(lineas.length === 4, `listó 4 fechas, que es el tope`, `listó ${lineas.length} fechas: el tope de 4 no se respetó`);
  // Lo importante no es solo cortar: es que el cliente SEPA que se cortó. Descartar 6 fechas en
  // silencio se siente como que el bot no lo escuchó.
  revisar(/6 fechas más/.test(texto), "le dice cuántas fechas quedaron fuera", "cortó en silencio, sin avisar cuántas faltaron");
  revisar(/cu[áa]l plan quieres que miremos/i.test(texto), "le pide que elija cuál plan mirar con detalle", "no le pide priorizar");
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El resumen de varias fechas sale corto, con datos de la base y sin abrumar.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
