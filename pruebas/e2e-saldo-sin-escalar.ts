/**
 * PRUEBA: después de abonar, preguntar por el saldo lo resuelve el bot SOLO — no "lo consulta
 * con el equipo".
 *
 * [2026-09-14] Daniel, mirando una conversación real: "no me gustan estos mensajes donde dice que
 * va a consultar algo con el equipo de La Julita... el bot debe resolver lo más que pueda, solo
 * se debe comunicar al equipo si algo falla o es muy muy necesario, pero preguntas tan básicas
 * debe responder y resolver".
 *
 * Lo que pasaba: con el abono ya pagado y saldo pendiente, cualquier intento de seguir con el
 * pago caía en la generación de un link nuevo — que falla, porque el abono de esa reserva ya está
 * pagado — y el cliente recibía "déjame confirmar un detalle del pago con el equipo". Al día
 * siguiente el recontacto le preguntaba "¿te paso los datos?", el cliente decía "sí"... y le
 * volvía a salir el mismo mensaje. Bucle, y con una promesa que no avisaba a nadie.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.OWNER_WHATSAPP_NUMBERS ||= "+573000000999";

const { instalarSupabaseFalso, instalarBoldFalso, filasDe } = await import("./fakes.js");
const { registerChannel } = await import("../src/channels/registry.js");

instalarSupabaseFalso();
instalarBoldFalso();

const avisosAlEquipo: string[] = [];
registerChannel({
  name: "whatsapp",
  async send(msg: { to: string; text?: string }) {
    avisosAlEquipo.push(msg.text ?? "");
  },
});

const { enviarDatosPagoTool, preguntarFormaDePagoTool } = await import("../src/agentes/ventas/herramientas/pago.js");

const CTX = { channel: "whatsapp", externalId: "+573212191805" };
const RESERVA = 200;
const TOTAL = 5000;
const ABONO = 2500;

filasDe("clientes").push({ id: 1, nombre: "Daniel Pataquiva", celular: "3212191805" });
filasDe("reservas").push({
  id: RESERVA,
  cliente_id: 1,
  fecha_reservada: "2026-09-15",
  numero_huespedes: 1,
  planes: { nombre: "PLAN UNA PERSONA UNA NOCHE DOMO DELUXE" },
});
// Ya abonó la mitad: es el estado exacto de la captura de Daniel.
filasDe("v_estado_cuenta").push({
  reserva_id: RESERVA,
  cliente_id: 1,
  cliente: "Daniel Pataquiva",
  celular: "3212191805",
  fecha_checkin: "2026-09-15",
  total: TOTAL,
  pagado: ABONO,
  saldo: TOTAL - ABONO,
  estado_pago: "con_anticipo",
  num_pagos: 1,
});
filasDe("pagos").push({
  id: 1,
  reserva_id: RESERVA,
  tipo: "abono",
  estado: "pagado",
  valor: ABONO,
  referencia: `reserva-${RESERVA}-abono`,
  payment_link: "LNK_PAGADO",
  link_url: "https://checkout.bold.co/payment/LNK_PAGADO",
});
filasDe("politicas").push({
  clave: "saldo_pendiente",
  contenido:
    "🗓 Si tu llegada es viernes, sábado, domingo de puente festivo o pasadía, el saldo se paga un día antes del check-in. De domingo a jueves, se paga al llegar al glamping.",
  activo: true,
});

let fallas = 0;
const DERIVA = /déjame confirmar un detalle del pago con el equipo/i;

console.log("CASO 1. El cliente pregunta por el saldo: el bot contesta solo, con la política\n");
{
  avisosAlEquipo.length = 0;
  const r = await preguntarFormaDePagoTool.handler({ reserva_id: RESERVA }, CTX);
  const texto = r.reply_to_user ?? "";
  console.log(`  (respuesta) ${texto.replace(/\n+/g, " ").slice(0, 150)}...`);

  if (DERIVA.test(texto)) {
    console.log("  ❌ salió el 'déjame confirmar con el equipo' para algo que el bot sabe contestar");
    fallas++;
  } else {
    console.log("  ✅ no derivó nada al equipo");
  }

  if (!texto.includes("2.500")) {
    console.log("  ❌ no le dice cuánto abonó ni cuánto queda");
    fallas++;
  } else {
    console.log("  ✅ le dice lo que ya abonó y el saldo que queda");
  }

  if (!/un día antes del check-in/i.test(texto)) {
    console.log("  ❌ no le explica CUÁNDO se paga el saldo (la política de la base)");
    fallas++;
  } else {
    console.log("  ✅ le explica cuándo se paga el saldo, con el texto oficial de la política");
  }

  if (avisosAlEquipo.length > 0) {
    console.log(`  ❌ molestó al equipo con ${avisosAlEquipo.length} aviso(s) por una pregunta básica`);
    fallas++;
  } else {
    console.log("  ✅ no se le mandó ningún aviso al equipo (no hacía falta)");
  }
}

console.log("\nCASO 2. El 'sí' del día siguiente tampoco cae en el bucle\n");
{
  avisosAlEquipo.length = 0;
  // Es lo que hizo el modelo en la conversación real: llamar enviar_datos_pago tras el "sí".
  const r = await enviarDatosPagoTool.handler({ reserva_id: RESERVA, modalidad: "abono" }, CTX);
  const texto = r.reply_to_user ?? "";
  console.log(`  (respuesta) ${texto.replace(/\n+/g, " ").slice(0, 150)}...`);

  if (DERIVA.test(texto)) {
    console.log("  ❌ volvió a caer en el mensaje de 'confirmo con el equipo' — el bucle sigue");
    fallas++;
  } else {
    console.log("  ✅ contestó con el estado real de su reserva, sin derivar");
  }
}

console.log("\nCASO 3. Si el cliente SÍ quiere pagar el saldo ya, se le genera el link\n");
{
  const r = await enviarDatosPagoTool.handler({ reserva_id: RESERVA, modalidad: "total" }, CTX);
  const texto = r.reply_to_user ?? "";
  if (!/checkout\.bold\.co/.test(texto)) {
    console.log(`  ❌ no le mandó el link para pagar el saldo: "${texto.slice(0, 120)}"`);
    fallas++;
  } else {
    console.log("  ✅ le llegó el link del saldo (el camino de pagar por adelantado sigue funcionando)");
  }
}

console.log("\nCASO 4. Cuando SÍ hay una falla real, ahora el equipo se entera de verdad\n");
{
  avisosAlEquipo.length = 0;
  // Una reserva que no existe: falla interna legítima, de las que sí hay que escalar.
  const r = await enviarDatosPagoTool.handler({ reserva_id: 999999, modalidad: "abono" }, {
    channel: "whatsapp",
    externalId: "+573000000111",
  });
  const texto = r.reply_to_user ?? "";
  await new Promise((listo) => setTimeout(listo, 30)); // los avisos salen en segundo plano

  if (!DERIVA.test(texto)) {
    console.log(`  ⚠️  contestó otra cosa (no es un problema en sí): "${texto.slice(0, 100)}"`);
  }
  if (avisosAlEquipo.length === 0) {
    console.log("  ❌ el cliente quedó esperando y NADIE del equipo se enteró (la promesa vacía de antes)");
    fallas++;
  } else {
    console.log(`  ✅ al equipo le llegó el aviso para que respondan (${avisosAlEquipo.length} mensaje(s))`);
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Las preguntas básicas las resuelve el bot; solo escala lo que de verdad falla.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
