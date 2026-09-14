/**
 * PRUEBA: el aviso técnico al equipo de desarrollo se manda cuando corresponde, y NO se repite
 * por la misma falla antes de la ventana de 2 horas — pedido explícito de Daniel (2026-09-13):
 * "cuando... algun servicio falla... debe informar al equipo de desarrollo de la julita", con un
 * throttle de "cada 2 horas" para no inundar el aviso si la falla sigue activa.
 *
 * [2026-09-13, más tarde el mismo día] El canal cambió de correo (pendiente, para más adelante) a
 * WhatsApp, al mismo número del bot — acá se registra un canal "whatsapp" de mentira para poder
 * confirmar que el mensaje de verdad se intenta mandar, además del throttle en sí.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
const { registerChannel } = await import("../src/channels/registry.js");
instalarSupabaseFalso();

const avisosWhatsapp: { to: string; text?: string }[] = [];
registerChannel({
  name: "whatsapp",
  async send(msg: { to: string; text?: string }) {
    avisosWhatsapp.push(msg);
  },
});

const { alertarFalloTecnico } = await import("../src/core/pipeline/notificarDesarrollo.js");

let fallas = 0;

function fila(clave: string) {
  return filasDe("alertas_tecnicas").find((f) => f.clave === clave);
}

console.log("CASO 1. Primera vez que falla algo: se registra el aviso\n");
{
  await alertarFalloTecnico({
    clave: "prueba:servicio_x",
    titulo: "Servicio X no respondió",
    detalle: "timeout de prueba",
  });
  const f = fila("prueba:servicio_x");
  if (!f) {
    console.log("  ❌ no quedó ninguna fila en alertas_tecnicas para 'prueba:servicio_x'");
    fallas++;
  } else if (f.veces !== 1) {
    console.log(`  ❌ veces=${f.veces}, esperaba 1`);
    fallas++;
  } else {
    console.log("  ✅ quedó registrada la primera alerta (veces=1)");
  }

  if (avisosWhatsapp.length !== 1) {
    console.log(`  ❌ se esperaba 1 mensaje de WhatsApp intentado, hubo ${avisosWhatsapp.length}`);
    fallas++;
  } else if (!avisosWhatsapp[0].to.includes("3246166787")) {
    console.log(`  ❌ el aviso se mandó a "${avisosWhatsapp[0].to}", no al número esperado`);
    fallas++;
  } else {
    console.log(`  ✅ se intentó mandar por WhatsApp a ${avisosWhatsapp[0].to}`);
  }
}

console.log("\nCASO 2. La MISMA falla, un segundo después: NO se repite el aviso\n");
{
  await alertarFalloTecnico({
    clave: "prueba:servicio_x",
    titulo: "Servicio X no respondió",
    detalle: "timeout de prueba, otra vez",
  });
  const f = fila("prueba:servicio_x");
  if (!f || f.veces !== 1) {
    console.log(`  ❌ veces=${f?.veces} — se repitió el aviso antes de la ventana de 2 horas`);
    fallas++;
  } else {
    console.log("  ✅ no se repitió el aviso (sigue en veces=1, todavía dentro de las 2 horas)");
  }
}

console.log("\nCASO 3. Una falla DISTINTA no se ve afectada por el throttle de la anterior\n");
{
  await alertarFalloTecnico({
    clave: "prueba:servicio_y",
    titulo: "Servicio Y no respondió",
    detalle: "otro timeout de prueba",
  });
  const f = fila("prueba:servicio_y");
  if (!f || f.veces !== 1) {
    console.log(`  ❌ 'prueba:servicio_y' no quedó registrada correctamente (veces=${f?.veces})`);
    fallas++;
  } else {
    console.log("  ✅ 'prueba:servicio_y' se avisó normalmente, sin que la afecte el throttle de servicio_x");
  }
}

console.log("\nCASO 4. Pasadas las 2 horas, la MISMA falla sí vuelve a avisar\n");
{
  // Simula que ya pasaron más de 2 horas desde el último aviso de 'prueba:servicio_x'.
  const f = fila("prueba:servicio_x")!;
  f.ultima_vez = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  await alertarFalloTecnico({
    clave: "prueba:servicio_x",
    titulo: "Servicio X no respondió",
    detalle: "sigue caído, 3 horas después",
  });
  const f2 = fila("prueba:servicio_x");
  if (!f2 || f2.veces !== 2) {
    console.log(`  ❌ veces=${f2?.veces}, esperaba 2 (debía volver a avisar tras pasar la ventana)`);
    fallas++;
  } else {
    console.log("  ✅ volvió a avisar tras pasar la ventana de 2 horas (veces=2)");
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ 4/4 casos pasaron. El throttle de avisos técnicos funciona.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
