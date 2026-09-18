/**
 * PRUEBA: un recontacto NO puede escribirle a una conversación que ya no existe.
 *
 * El caso real (2026-09-17, probando con Daniel): a las 4:07 p. m. hizo `/reset`, el bot le
 * confirmó "Borré todo lo de este número", y un minuto después — sin que él escribiera nada — le
 * llegó "¡Hola! ¿Cómo estás? ¿Te cuento los planes del glamping La Julita para que veas cuál te
 * gusta más?". Era el paso 1 de la cadena de recontactos, programado 20 minutos antes por la
 * charla anterior: vive en Redis, así que el reset (que borra filas de Supabase) no lo tocaba, y
 * su chequeo de "¿el cliente ya contestó?" mira el historial, que el reset acababa de dejar
 * vacío — o sea que daba que no y el recontacto salía igual.
 *
 * Lo grave no es el mensaje de más: es que quedaba siendo el PRIMER mensaje de la conversación
 * nueva, así que el cliente nunca veía el saludo oficial con el aviso de la política de datos.
 *
 * Se arregló por los dos lados y esta prueba cubre el segundo, que es el que protege aunque el
 * recontacto se haya programado desde otro proceso:
 *   1. `/reset` cancela el recontacto pendiente (ver el comando en core/pipeline/comandos.ts).
 *   2. `ejecutarRecontacto` no manda nada si no queda historial — lo que se prueba acá.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";

const { instalarSupabaseFalso, instalarModeloFalso, usarGuion, sembrarMensajes, adaptadorFalso, enviados } =
  await import("./fakes.js");
instalarSupabaseFalso();
instalarModeloFalso();

const { ejecutarRecontacto } = await import("../src/core/pipeline/recontacto.js");

const CANAL = "prueba";
const CHAT = "+573009990001";

// El recontacto pide texto libre, no herramientas: el modelo falso devuelve siempre este saludo.
usarGuion(() => ({ texto: "¡Hola! ¿Cómo estás? ¿Te cuento los planes del glamping La Julita? 🌿" }));

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

/** El ancla es el último mensaje del bot: el recontacto se programó justo después de él. */
const HACE_UNA_HORA = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const JOB = { canal: CANAL, externalId: CHAT, paso: 1, ancla: HACE_UNA_HORA };

console.log("█".repeat(92));
console.log("  PRUEBA — recontacto huérfano: después de un /reset no le puede escribir a nadie");
console.log("█".repeat(92));

console.log("\nCASO 1. La conversación se borró (/reset): el recontacto NO sale\n");
{
  sembrarMensajes([]);
  enviados.length = 0;

  await ejecutarRecontacto(JOB, adaptadorFalso as any);

  revisar(
    enviados.length === 0,
    "no le llegó nada al número recién reseteado",
    `le llegó un mensaje de la nada: "${enviados[0]}" — se saltaría el saludo con la política de datos`
  );
}

console.log("\nCASO 2. Con la charla viva y sin respuesta del cliente, el recontacto SÍ sale\n");
{
  // Lo que defiende este caso: que el arreglo de arriba no haya apagado la función entera.
  sembrarMensajes([
    { canal: CANAL, external_id: CHAT, role: "user", content: "hola, qué planes tienen?", created_at: new Date(Date.now() - 90 * 60 * 1000).toISOString() },
    { canal: CANAL, external_id: CHAT, role: "assistant", content: "¡Hola! Te cuento: tenemos planes para parejas y familias 💚", created_at: HACE_UNA_HORA },
  ]);
  enviados.length = 0;

  await ejecutarRecontacto(JOB, adaptadorFalso as any);

  revisar(enviados.length === 1, "mandó el recontacto de la cadena", `mandó ${enviados.length} mensajes, se esperaba 1`);
}

console.log("\nCASO 3. Si el cliente ya contestó después del ancla, tampoco sale\n");
{
  sembrarMensajes([
    { canal: CANAL, external_id: CHAT, role: "user", content: "hola", created_at: new Date(Date.now() - 90 * 60 * 1000).toISOString() },
    { canal: CANAL, external_id: CHAT, role: "assistant", content: "¡Hola! ¿Para qué fecha lo tienes pensado?", created_at: HACE_UNA_HORA },
    { canal: CANAL, external_id: CHAT, role: "user", content: "para el 20", created_at: new Date().toISOString() },
  ]);
  enviados.length = 0;

  await ejecutarRecontacto(JOB, adaptadorFalso as any);

  revisar(enviados.length === 0, "no insiste cuando el cliente ya escribió", `le escribió igual: "${enviados[0]}"`);
}

console.log("\n" + "█".repeat(92));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El recontacto solo sale cuando hay una charla viva que retomar.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(92));
