/**
 * SIMULACIÓN COMPLETA DE UN PAGO, SIN PAGAR DE VERDAD.
 *
 * [2026-09-14] Daniel no puede hacer otro pago real (la persona que los hace no está), así que
 * acá se simula que Bold responde "ya pagaron" y se corre el flujo REAL del bot, de punta a
 * punta, para comprobar los arreglos del bug del 13/09:
 *
 *   - pagó el abono del 50%,
 *   - el bot le confirmó la reserva,
 *   - en LobbyPMS no quedó NADA creado,
 *   - y a los 10 minutos el cupo se liberó igual.
 *
 * Lo único simulado es lo que sale a la red: Bold, LobbyPMS y Supabase. Todo lo demás
 * (verificar_pago, confirmarReserva, la liberación de los 10 minutos) es el código de producción
 * sin tocar.
 *
 * Se prueban los TRES caminos por los que hoy se puede confirmar un pago solo, más el caso feo
 * de LobbyPMS caído.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";
process.env.OWNER_WHATSAPP_NUMBERS ||= "+573212191805";

const {
  instalarSupabaseFalso,
  instalarBoldFalso,
  instalarLobbyFalso,
  boldResponderaEstado,
  lobbyResponderaBooking,
  filasDe,
  reservasCreadasLobby,
  blocksLiberadosLobby,
} = await import("./fakes.js");
const { registerChannel } = await import("../src/channels/registry.js");

instalarSupabaseFalso();
instalarLobbyFalso();
instalarBoldFalso(); // OJO: después de lobby — los dos tocan axios y bold pisa `create`.

/** Todo lo que el bot manda por WhatsApp (al cliente y al equipo). */
const mensajesWhatsapp: { to: string; text: string }[] = [];
registerChannel({
  name: "whatsapp",
  async send(msg: { to: string; text?: string }) {
    mensajesWhatsapp.push({ to: msg.to, text: msg.text ?? "" });
  },
});

const { verificarPagoTool } = await import("../src/agentes/ventas/herramientas/pago.js");
const { ejecutarLiberacionBloqueo } = await import("../src/core/pipeline/bloqueo.js");
const { finalizarPagoConfirmado } = await import("../src/core/pipeline/confirmarReserva.js");

const CANAL = "whatsapp";
const CLIENTE = "+573212191805";
const TOTAL = 5000;
const ABONO = 2500;

let proximoId = 100;

/** Deja todo como quedó justo después de que el bot le mandó el link del abono al cliente. */
function sembrarEscenario(): { reservaId: number; bloqueoId: number } {
  const reservaId = proximoId++;
  const bloqueoId = proximoId++;
  const clienteId = proximoId++;

  filasDe("clientes").push({
    id: clienteId,
    nombre: "Daniel Pataquiva",
    numero_documento: "10009040603",
    celular: CLIENTE.replace("+57", ""),
    correo: "daniel@ejemplo.com",
    tipo_documento_id: 1,
  });
  filasDe("tipo_documento").push({ id: 1, nombre: "CC" });

  filasDe("reservas").push({
    id: reservaId,
    cliente_id: clienteId,
    fecha_reservada: "2026-09-15",
    numero_huespedes: 1,
    planes: { nombre: "PLAN UNA PERSONA UNA NOCHE DOMO DELUXE" },
  });

  filasDe("v_estado_cuenta").push({
    reserva_id: reservaId,
    cliente_id: clienteId,
    cliente: "Daniel Pataquiva",
    celular: CLIENTE.replace("+57", ""),
    fecha_checkin: "2026-09-15",
    total: TOTAL,
    pagado: 0,
    saldo: TOTAL,
    estado_pago: "pendiente",
    num_pagos: 0,
  });

  // El link del abono, todavía pendiente de pago.
  filasDe("pagos").push({
    id: proximoId++,
    reserva_id: reservaId,
    tipo: "abono",
    estado: "pendiente",
    valor: ABONO,
    referencia: `reserva-${reservaId}-abono`,
    payment_link: `LNK_RESERVA${reservaId}`,
    link_url: `https://checkout.bold.co/payment/LNK_RESERVA${reservaId}`,
  });

  // El cupo apartado por 10 minutos, con todo lo que LobbyPMS necesita para crear la reserva.
  filasDe("bloqueos_temporales").push({
    id: bloqueoId,
    canal: CANAL,
    external_id: CLIENTE,
    plan_id: 1,
    clase_domo: "deluxe",
    capacidad: 1,
    fecha_entrada: "2026-09-15",
    noches: 1,
    estado: "pendiente",
    creado_en: new Date().toISOString(),
    expira_en: new Date(Date.now() + 10 * 60_000).toISOString(),
    avisado: false,
    cliente_id: clienteId,
    personas: 1,
    valor_total: TOTAL,
    lobby_block_id: 9999,
    lobby_category_id: 33,
    lobby_booking_id: null,
    lobby_room_id: null,
    ninos: 0,
  });

  return { reservaId, bloqueoId };
}

function bloqueoDe(id: number) {
  return filasDe("bloqueos_temporales").find((b) => b.id === id);
}

const adaptadorWhatsapp = {
  name: CANAL,
  async send(msg: { to: string; text?: string }) {
    mensajesWhatsapp.push({ to: msg.to, text: msg.text ?? "" });
  },
};

let fallas = 0;
function revisar(condicion: boolean, bien: string, mal: string) {
  if (condicion) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

// ============================================================================================
console.log("CASO 1. El cliente dice 'ya pagué' (Bold confirma el abono del 50%)\n");
// ============================================================================================
{
  const { reservaId, bloqueoId } = sembrarEscenario();
  mensajesWhatsapp.length = 0;
  reservasCreadasLobby.length = 0;
  boldResponderaEstado({ status: "PAID", transaction_id: "TX-SIMULADA-1", total: ABONO });

  const salida = await verificarPagoTool.handler({ reserva_id: reservaId }, { channel: CANAL, externalId: CLIENTE });
  const textoAlCliente = salida.reply_to_user ?? "";
  // El cierre (confirmar bloqueo + crear en LobbyPMS) se dispara en segundo plano a propósito,
  // para no demorarle la respuesta al cliente: se le da un instante para terminar.
  await new Promise((listo) => setTimeout(listo, 50));

  console.log(`  (mensaje al cliente) ${textoAlCliente.split("\n")[0]}`);

  revisar(
    /confirmado/i.test(textoAlCliente) && textoAlCliente.includes("2.500"),
    "al cliente se le confirma el abono de $2.500",
    `el mensaje al cliente no confirma bien el abono: "${textoAlCliente.slice(0, 120)}"`
  );
  revisar(
    !/déjame confirmar un detalle del pago/i.test(textoAlCliente),
    "ya NO sale el 'déjame confirmar un detalle del pago con el equipo'",
    "salió el mensaje de 'déjame confirmar con el equipo' (el bug de la captura)"
  );
  revisar(
    reservasCreadasLobby.length === 1,
    "la reserva SÍ se creó en LobbyPMS (POST /bookings)",
    `en LobbyPMS se crearon ${reservasCreadasLobby.length} reservas — se esperaba 1`
  );
  revisar(
    bloqueoDe(bloqueoId)?.estado === "confirmado",
    "el bloqueo quedó marcado como confirmado",
    `el bloqueo quedó en estado "${bloqueoDe(bloqueoId)?.estado}" en vez de "confirmado"`
  );
  revisar(
    bloqueoDe(bloqueoId)?.lobby_booking_id === 55501,
    "se guardó el número de reserva de LobbyPMS en el bloqueo",
    "no se guardó el número de reserva de LobbyPMS"
  );

  const datosReserva = reservasCreadasLobby[0] ?? {};
  console.log(
    `  (lo que se le mandó a LobbyPMS) categoría=${datosReserva.category_id} ` +
      `entrada=${datosReserva.start_date} salida=${datosReserva.end_date} adultos=${datosReserva.total_adults}`
  );
}

// ============================================================================================
console.log("\nCASO 2. Pasan los 10 minutos: el cupo YA NO se libera (este era el bug grave)\n");
// ============================================================================================
{
  const { reservaId, bloqueoId } = sembrarEscenario();
  mensajesWhatsapp.length = 0;
  boldResponderaEstado({ status: "PAID", transaction_id: "TX-SIMULADA-2", total: ABONO });

  // Primero paga y se confirma, como en el caso 1.
  await verificarPagoTool.handler({ reserva_id: reservaId }, { channel: CANAL, externalId: CLIENTE });
  await new Promise((listo) => setTimeout(listo, 50));

  // Ahora se dispara la liberación de los 10 minutos igual (como si no se hubiera alcanzado a
  // cancelar el job) — es exactamente lo que le pasó a Daniel.
  mensajesWhatsapp.length = 0;
  blocksLiberadosLobby.length = 0;
  await ejecutarLiberacionBloqueo(
    { bloqueoId, canal: CANAL, externalId: CLIENTE },
    adaptadorWhatsapp as any
  );

  const avisoDeLiberacion = mensajesWhatsapp.find((m) => /liberé el cupo/i.test(m.text));
  revisar(
    !avisoDeLiberacion,
    "NO se le mandó el mensaje de 'liberé el cupo que te había apartado'",
    "¡se le mandó el aviso de cupo liberado a un cliente que YA pagó!"
  );
  revisar(
    bloqueoDe(bloqueoId)?.estado !== "liberado",
    `el cupo sigue siendo del cliente (estado "${bloqueoDe(bloqueoId)?.estado}")`,
    "el cupo se liberó pese a que el cliente ya había pagado"
  );
}

// ============================================================================================
console.log("\nCASO 3. El webhook de Bold confirma solo (el cliente ni escribe)\n");
// ============================================================================================
{
  const { reservaId, bloqueoId } = sembrarEscenario();
  reservasCreadasLobby.length = 0;

  // Es el mismo cierre que ejecuta el webhook en web/server.ts después de registrar el pago.
  await finalizarPagoConfirmado({ bloqueoId, reservaId, origen: "webhook-bold" });

  revisar(
    reservasCreadasLobby.length === 1,
    "por el camino del webhook también se crea la reserva en LobbyPMS",
    "el webhook confirmó el pago pero no creó la reserva en LobbyPMS"
  );
  revisar(
    bloqueoDe(bloqueoId)?.estado === "confirmado",
    "el bloqueo quedó confirmado",
    `el bloqueo quedó en "${bloqueoDe(bloqueoId)?.estado}"`
  );
}

// ============================================================================================
console.log("\nCASO 4. Se llama dos veces (webhook + 'ya pagué' a la vez): NO se duplica la reserva\n");
// ============================================================================================
{
  const { reservaId, bloqueoId } = sembrarEscenario();
  reservasCreadasLobby.length = 0;

  await finalizarPagoConfirmado({ bloqueoId, reservaId, origen: "webhook-bold" });
  await finalizarPagoConfirmado({ bloqueoId, reservaId, origen: "verificar_pago" });
  await finalizarPagoConfirmado({ bloqueoId, reservaId, origen: "chequeo-temprano" });

  revisar(
    reservasCreadasLobby.length === 1,
    "tres confirmaciones seguidas crearon UNA sola reserva en LobbyPMS",
    `se crearon ${reservasCreadasLobby.length} reservas en LobbyPMS — se está duplicando`
  );
}

// ============================================================================================
console.log("\nCASO 5. LobbyPMS falla: al equipo le tiene que llegar el aviso para crearla a mano\n");
// ============================================================================================
{
  const { reservaId, bloqueoId } = sembrarEscenario();
  mensajesWhatsapp.length = 0;
  reservasCreadasLobby.length = 0;
  lobbyResponderaBooking(false); // LobbyPMS rechaza la creación

  await finalizarPagoConfirmado({ bloqueoId, reservaId, origen: "webhook-bold" });

  const avisoAlEquipo = mensajesWhatsapp.find((m) => /crear A MANO en LobbyPMS/i.test(m.text));
  revisar(
    Boolean(avisoAlEquipo),
    "al equipo le llegó el WhatsApp de 'reserva pagada, créenla a mano'",
    "nadie se enteró: no salió el aviso al equipo (este caso quedaba en silencio)"
  );
  if (avisoAlEquipo) {
    revisar(
      avisoAlEquipo.text.includes(String(bloqueoId)) && avisoAlEquipo.text.includes("2026-09-15"),
      "el aviso trae el bloqueo y la fecha, para poder crearla",
      "el aviso no trae los datos necesarios"
    );
  }
  lobbyResponderaBooking(true);
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Pago simulado de punta a punta: se confirma, se crea en LobbyPMS y el cupo no se pierde.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
}
console.log("█".repeat(96));

// Esta prueba sí toca la cola (cancelarSeguimientoDePago), así que queda abierta la conexión a
// Redis y el proceso no terminaría solo. Se cierra a mano: lo que había que comprobar ya está.
process.exit(fallas === 0 ? 0 : 1);
