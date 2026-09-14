/**
 * PRUEBA: el bot ya NO contesta cada mensaje de una racha por separado.
 *
 * [2026-09-14] Reportado por Daniel: un cliente mandó el documento, la cédula y la edad en
 * mensajes separados ("CC80419360", "cc52841275", "45", "50") y el bot le preguntó lo mismo DOS
 * VECES seguidas — porque cada mensaje entraba como un trabajo independiente y se procesaba
 * (y se contestaba) antes de que llegara el siguiente. Se portó el mecanismo de debounce+buffer
 * que ya tenía agente-ycloud-main ("Sebas Raider") — ver core/queue/inboundQueue.ts.
 *
 * Esta prueba corre contra Redis DE VERDAD (no un fake) y contra BullMQ de verdad: es la única
 * forma honesta de probar un delay real reiniciándose con cada mensaje nuevo. No usa
 * handleInbound (el pipeline completo) — eso ya lo cubren e2e-orquestador.ts, e2e-precio.ts,
 * etc. — sino un processor de prueba que solo cuenta cuántas veces corrió y qué encontró en el
 * buffer, para verificar el mecanismo de encolado en sí mismo.
 *
 * Requiere un Redis corriendo en 127.0.0.1:6379 (o REDIS_URL ya seteado antes de correr esto).
 */
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";
// Debounce corto para que la prueba no tarde minutos — el valor real en producción es 20000ms
// (ver .env.example), acá lo único que importa es que el mecanismo de reinicio funcione igual.
process.env.DEBOUNCE_MS = "300";

const { enqueueInbound, drainInboundBuffer, combinarEventosDelBuffer, QUEUE_INBOUND } = await import(
  "../src/core/queue/inboundQueue.js"
);
const { getRedisConnection } = await import("../src/core/queue/redis.js");
const { Worker } = await import("bullmq");
const { setTimeout: esperar } = await import("node:timers/promises");

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

console.log("CASO 1. combinarEventosDelBuffer: junta texto puro, respeta el orden, no toca media\n");
{
  const base = { channel: "whatsapp", externalId: "+573000000201", timestamp: "2026-09-14T10:00:00.000Z" };

  // Un solo evento: pasa igual, sin envolver en nada raro.
  const uno = combinarEventosDelBuffer([{ ...base, text: "hola" }]);
  revisar(uno.length === 1 && uno[0].text === "hola", "un solo evento no se toca", `dio ${JSON.stringify(uno)}`);

  // Varios de texto puro: se juntan en UNO, con \n, en el orden original.
  const combinados = combinarEventosDelBuffer([
    { ...base, text: "CC80419360" },
    { ...base, text: "cc52841275" },
    { ...base, text: "45" },
    { ...base, text: "50" },
  ]);
  revisar(combinados.length === 1, "varios mensajes de texto se juntan en uno solo", `quedaron ${combinados.length}`);
  revisar(
    combinados[0]?.text === "CC80419360\ncc52841275\n45\n50",
    "el texto combinado respeta el orden y usa salto de línea",
    `texto combinado: ${JSON.stringify(combinados[0]?.text)}`
  );

  // Si hay un audio/imagen mezclado con texto, NO se combinan: se procesan por separado.
  const mixto = combinarEventosDelBuffer([
    { ...base, text: "te mando el comprobante" },
    { ...base, mediaType: "image" as const, mediaUrl: "https://x/y.jpg" },
  ]);
  revisar(mixto.length === 2, "media mezclado con texto NO se combina (se procesa cada uno)", `quedó en ${mixto.length}`);
}

console.log("\nCASO 2. Una racha de 4 mensajes seguidos dispara el trabajo UNA sola vez, con los 4 juntos\n");
{
  const procesados: { channel: string; externalId: string; textos: (string | undefined)[] }[] = [];

  const worker = new Worker(
    QUEUE_INBOUND,
    async (job) => {
      const { channel, externalId } = job.data as { channel: string; externalId: string };
      const eventos = await drainInboundBuffer(channel, externalId);
      if (eventos.length === 0) return; // carrera del jobId independiente — no es error
      procesados.push({ channel, externalId, textos: eventos.map((e) => e.text) });
    },
    { connection: getRedisConnection() }
  );
  await esperar(200); // darle tiempo al worker de conectarse antes de mandar la racha

  const cliente = "+573000000202";
  const mensajes = ["CC80419360", "cc52841275", "45", "50"];
  for (const texto of mensajes) {
    await enqueueInbound({ channel: "whatsapp", externalId: cliente, text: texto, timestamp: new Date().toISOString() });
    await esperar(80); // bien por debajo del debounce (300ms): simula que escribe rápido
  }

  // Esperar más que el debounce, contado desde el ÚLTIMO mensaje de la racha.
  await esperar(600);

  revisar(procesados.length === 1, "el trabajo corrió UNA sola vez para toda la racha", `corrió ${procesados.length} veces`);
  revisar(
    JSON.stringify(procesados[0]?.textos) === JSON.stringify(mensajes),
    "el buffer traía los 4 mensajes juntos, en el orden en que se mandaron",
    `trajo: ${JSON.stringify(procesados[0]?.textos)}`
  );

  await worker.close();
}

console.log("\nCASO 3. Dos conversaciones distintas NO se mezclan ni se bloquean entre sí\n");
{
  const procesados: { externalId: string; n: number }[] = [];

  const worker = new Worker(
    QUEUE_INBOUND,
    async (job) => {
      const { channel, externalId } = job.data as { channel: string; externalId: string };
      const eventos = await drainInboundBuffer(channel, externalId);
      if (eventos.length === 0) return;
      procesados.push({ externalId, n: eventos.length });
    },
    { connection: getRedisConnection() }
  );
  await esperar(200);

  await enqueueInbound({ channel: "whatsapp", externalId: "+573000000203", text: "a", timestamp: new Date().toISOString() });
  await enqueueInbound({ channel: "whatsapp", externalId: "+573000000204", text: "b", timestamp: new Date().toISOString() });
  await enqueueInbound({ channel: "whatsapp", externalId: "+573000000203", text: "c", timestamp: new Date().toISOString() });

  await esperar(600);

  const c203 = procesados.find((p) => p.externalId === "+573000000203");
  const c204 = procesados.find((p) => p.externalId === "+573000000204");
  revisar(procesados.length === 2, "cada conversación disparó su PROPIO trabajo", `hubo ${procesados.length} trabajos`);
  revisar(c203?.n === 2, "la conversación 203 juntó sus 2 mensajes", `c203 trajo ${c203?.n}`);
  revisar(c204?.n === 1, "la conversación 204 no se contaminó con la otra", `c204 trajo ${c204?.n}`);

  await worker.close();
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Los mensajes seguidos del mismo cliente ya se procesan como un solo turno.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));

await getRedisConnection().quit();
