/**
 * PRUEBA: no se le puede cobrar a un cliente el monto de la reserva de OTRO.
 *
 * [2026-09-13] Bug real, encontrado por Daniel probando en WhatsApp: registró una reserva nueva
 * (plan de $5.000 de prueba) y al pedir pagar la mitad, el link que le llegó fue de $190.000 —
 * la mitad de OTRA reserva, de OTRO cliente, de una prueba de días antes.
 *
 * Lo que pasó: `enviar_datos_pago` confiaba ciegamente en el `reserva_id` que el MODELO
 * escribiera en su llamada. En una conversación larga (varias reservas de prueba seguidas en el
 * mismo chat) el modelo repitió un `reserva_id` viejo, y como esa reserva vieja ya tenía un link
 * pendiente sin pagar, el código lo reusó tal cual (`conseguirLink` reusa el link pendiente de
 * reserva_id+tipo) — el cliente recibió el link de la reserva equivocada, por el monto
 * equivocado.
 *
 * La arreglada: `registrar_datos_reserva` ahora anota, en `conversacionActivaRepo`, qué reserva
 * quedó activa en ESTA conversación (channel+externalId). `enviar_datos_pago` (y
 * `preguntar_forma_de_pago`, que comparten la misma función) usan esa reserva de la conversación
 * por encima de cualquier `reserva_id` que el modelo mande — así que aunque el modelo se
 * equivoque, el cliente nunca puede terminar pagando la reserva de otro.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";

const { instalarSupabaseFalso, instalarBoldFalso, filasDe, linksPedidosABold } = await import("./fakes.js");

instalarSupabaseFalso();
instalarBoldFalso();

const { enviarDatosPagoTool } = await import("../src/agentes/ventas/herramientas/pago.js");
const { recordarReservaActiva } = await import("../src/core/db/conversacionActivaRepo.js");

// --- Dos clientes, dos reservas, dos conversaciones de WhatsApp distintas -------------------
const CANAL = "whatsapp";

const CLIENTE_A = { externalId: "+573001112222", reservaId: 7, total: 5000, celular: "3001112222" };
const CLIENTE_B = { externalId: "+573009998888", reservaId: 1, total: 760000, celular: "3009998888" };

function sembrarClienteYReserva(c: { reservaId: number; total: number; celular: string }, clienteId: number) {
  filasDe("clientes").push({ id: clienteId, nombre: "Cliente de prueba", celular: c.celular });
  filasDe("reservas").push({ id: c.reservaId, cliente_id: clienteId, fecha_reservada: "2026-10-10", numero_huespedes: 1, planes: { nombre: "PLAN DE PRUEBA" } });
  filasDe("v_estado_cuenta").push({
    reserva_id: c.reservaId,
    cliente_id: clienteId,
    cliente: "Cliente de prueba",
    celular: c.celular,
    fecha_checkin: "2026-10-10",
    total: c.total,
    pagado: 0,
    saldo: c.total,
    estado_pago: "pendiente",
    num_pagos: 0,
  });
}

sembrarClienteYReserva(CLIENTE_A, 101);
sembrarClienteYReserva(CLIENTE_B, 102);

// Cada uno registró su propia reserva en su propia conversación — así queda anotado hoy.
await recordarReservaActiva(CANAL, CLIENTE_A.externalId, CLIENTE_A.reservaId);
await recordarReservaActiva(CANAL, CLIENTE_B.externalId, CLIENTE_B.reservaId);

let fallas = 0;

console.log("CASO 1. El modelo pide la reserva de OTRO cliente por error — no se le cobra esa\n");
{
  // El cliente A está en su conversación, pero el modelo (equivocado, o con contexto viejo)
  // llama a la herramienta con el reserva_id del cliente B.
  const resultado = await enviarDatosPagoTool.handler(
    { reserva_id: CLIENTE_B.reservaId, modalidad: "abono" },
    { channel: CANAL, externalId: CLIENTE_A.externalId }
  );

  const r = resultado.result as any;
  const anticipoEsperado = Math.floor(CLIENTE_A.total * 0.5);

  if (r.reserva_id !== CLIENTE_A.reservaId) {
    console.log(`  ❌ usó la reserva #${r.reserva_id}, debía usar la #${CLIENTE_A.reservaId} (la de esta conversación)`);
    fallas++;
  } else if (r.valor_del_link !== anticipoEsperado) {
    console.log(`  ❌ cobró ${r.valor_del_link}, debía cobrar ${anticipoEsperado} (el 50% de la reserva del cliente A)`);
    fallas++;
  } else {
    console.log(`  ✅ ignoró el reserva_id equivocado (#${CLIENTE_B.reservaId}) y cobró la reserva de esta conversación (#${CLIENTE_A.reservaId}, ${anticipoEsperado})`);
  }

  const pedido = linksPedidosABold.at(-1);
  const montoPedido = pedido?.body?.amount?.total_amount;
  if (!pedido || montoPedido !== anticipoEsperado) {
    console.log(`  ❌ a Bold se le pidió un link por ${montoPedido} en vez de ${anticipoEsperado}`);
    fallas++;
  } else {
    console.log(`  ✅ a Bold se le pidió el link por el monto correcto (${montoPedido})`);
  }
}

console.log("\nCASO 2. Sin reserva_id del modelo, la conversación igual sabe cuál es la suya\n");
{
  const resultado = await enviarDatosPagoTool.handler(
    { modalidad: "total" },
    { channel: CANAL, externalId: CLIENTE_B.externalId }
  );
  const r = resultado.result as any;
  if (r.reserva_id !== CLIENTE_B.reservaId) {
    console.log(`  ❌ usó la reserva #${r.reserva_id}, debía usar la #${CLIENTE_B.reservaId}`);
    fallas++;
  } else {
    console.log(`  ✅ resolvió la reserva #${CLIENTE_B.reservaId} sin que el modelo mandara reserva_id`);
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log(`  RESULTADO: ✅ 2/2 casos pasaron. Ningún cliente puede terminar pagando la reserva de otro.`);
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
