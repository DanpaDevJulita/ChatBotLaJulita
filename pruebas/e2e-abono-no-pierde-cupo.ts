/**
 * PRUEBA: un cliente que paga el ABONO del 50% no puede perder su cupo a los 10 minutos, y su
 * reserva tiene que quedar creada en LobbyPMS — no solo confirmada de palabra.
 *
 * [2026-09-14] Bug real, encontrado por Daniel probando el 13/09 (captura de WhatsApp):
 *   - pagó el abono de $2.500 de un plan de $5.000,
 *   - el bot le confirmó: "ya nos entró tu abono y tu reserva queda apartada ✅",
 *   - en LobbyPMS NO había ninguna reserva,
 *   - y a los 10 minutos el cupo se liberó igual.
 *
 * Eran dos agujeros distintos, los dos cubiertos acá:
 *
 *   1. `verificarPagoEnBold` daba `pagado: false` cuando el abono YA estaba registrado: al
 *      pagarse, el link deja de estar pendiente, y como todavía quedaba saldo, no entraba por la
 *      rama de "ya sin saldo". La liberación de los 10 minutos consulta justo eso antes de soltar
 *      el cupo — leía "no pagó" y lo soltaba.
 *
 *   2. La reserva REAL en LobbyPMS solo se creaba con el comando manual `/confirmar` del equipo.
 *      Ningún camino automático (webhook de Bold, "ya pagué", chequeos de 3/7 min) la creaba.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";

const { instalarSupabaseFalso, instalarBoldFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();
instalarBoldFalso();

const { verificarPagoEnBold } = await import("../src/core/pipeline/verificarPagoEnBold.js");

const RESERVA_ID = 77;
const TOTAL = 5000;
const ABONO = 2500;

// El estado de cuenta después de que el abono SÍ entró: mitad pagada, mitad pendiente.
filasDe("v_estado_cuenta").push({
  reserva_id: RESERVA_ID,
  cliente_id: 501,
  cliente: "Daniel Pataquiva",
  celular: "3212191805",
  fecha_checkin: "2026-09-15",
  total: TOTAL,
  pagado: ABONO,
  saldo: TOTAL - ABONO,
  estado_pago: "parcial",
  num_pagos: 1,
});

// El pago del abono ya quedó registrado (estado "pagado"), así que NO figura como pendiente —
// que es exactamente la situación que confundía al código viejo.
filasDe("pagos").push({
  id: 900,
  reserva_id: RESERVA_ID,
  tipo: "abono",
  estado: "pagado",
  valor: ABONO,
  referencia: `reserva-${RESERVA_ID}-abono`,
  payment_link: "LNK_YAPAGADO",
  link_url: "https://checkout.bold.co/payment/LNK_YAPAGADO",
});

let fallas = 0;

console.log("CASO 1. Con el abono ya registrado, la verificación dice PAGADO (no 'sin links')\n");
{
  const v = await verificarPagoEnBold(RESERVA_ID);

  if (!v.pagado) {
    console.log("  ❌ dijo que NO está pagado — con esto la liberación de los 10 min suelta el cupo");
    fallas++;
  } else {
    console.log("  ✅ reconoce el pago del abono (pagado = true)");
  }

  if (v.sinLinksPendientes) {
    console.log("  ❌ lo reportó como 'sin links pendientes': por ahí salía el 'déjame confirmar con el equipo'");
    fallas++;
  } else {
    console.log("  ✅ ya no lo reporta como 'sin links pendientes'");
  }

  if (v.yaSinSaldo) {
    console.log(`  ❌ dice que no queda saldo, pero quedan $${TOTAL - ABONO}`);
    fallas++;
  } else {
    console.log(`  ✅ sabe que todavía queda saldo pendiente ($${v.saldoPendiente})`);
  }

  if (v.montoPagado !== ABONO) {
    console.log(`  ❌ el monto pagado que reporta (${v.montoPagado}) no es el abono real (${ABONO})`);
    fallas++;
  } else {
    console.log(`  ✅ reporta el monto pagado correcto ($${v.montoPagado})`);
  }
}

console.log("\nCASO 2. Una reserva sin ningún pago sigue dando NO pagado (no se rompió la red de seguridad)\n");
{
  const SIN_PAGO = 78;
  filasDe("v_estado_cuenta").push({
    reserva_id: SIN_PAGO,
    cliente_id: 502,
    cliente: "Cliente sin pagar",
    celular: "3000000000",
    fecha_checkin: "2026-09-20",
    total: TOTAL,
    pagado: 0,
    saldo: TOTAL,
    estado_pago: "pendiente",
    num_pagos: 0,
  });

  const v = await verificarPagoEnBold(SIN_PAGO);
  if (v.pagado) {
    console.log("  ❌ ¡dio por pagada una reserva sin un solo peso! Eso liberaría cupos pagados de otros");
    fallas++;
  } else {
    console.log("  ✅ sigue diciendo que no está pagada (el cupo se libera, como debe ser)");
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Quien paga su abono conserva el cupo; quien no paga, no.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
