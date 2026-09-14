/**
 * PRUEBA: las políticas del glamping salen de la BASE y llegan al cliente TAL CUAL.
 *
 * [2026-09-13] Daniel pasó las piezas oficiales (términos y condiciones + información antes de
 * reservar) y pidió que vivan en una tabla para poder cambiarlas sin tocar código. Lo que se
 * verifica acá es justamente lo que puede salir caro si se rompe:
 *
 *   - `consultar_politicas` devuelve el texto EXACTO de la tabla, sin recortarlo ni adornarlo
 *     (son condiciones comerciales: un plazo o un monto cambiado es una promesa que el negocio
 *     no va a poder cumplir);
 *   - va marcada como texto literal (`permitirRedaccion: false`), que es lo que impide que el
 *     modelo la reescriba con su voz;
 *   - si la tabla está vacía (nadie corrió sql/politicas.sql), el bot NO improvisa una política:
 *     deriva al equipo;
 *   - el mensaje del link de pago trae las condiciones ANTES de pagar, con las cifras de la base;
 *   - si se edita la política en la tabla, el cambio se ve en el mensaje del cliente (que es el
 *     sentido de tenerla en la base y no en el código).
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";

import { registerChannel } from "../src/channels/registry.js";

const { instalarSupabaseFalso, instalarBoldFalso, filasDe } = await import("./fakes.js");

instalarSupabaseFalso();
instalarBoldFalso();

const enviados: string[] = [];
registerChannel({
  name: "whatsapp",
  async send(m: { to: string; text?: string }) {
    enviados.push(m.text ?? "");
  },
});

const { consultarPoliticasTool } = await import("../src/agentes/ventas/herramientas/politicas.js");
const { enviarDatosPagoTool } = await import("../src/agentes/ventas/herramientas/pago.js");
const { invalidarCachePoliticas } = await import("../src/core/db/politicasRepo.js");
const { textoDeConfirmacion } = await import("../src/core/pipeline/avisarPago.js");

const CHAT = "+573200000777";
const RESERVA = 777;
const TOTAL = 700000;

// Los textos de prueba son cortos a propósito: lo que se verifica es que lleguen EXACTOS, no
// cuál es su contenido (el contenido real vive en sql/politicas.sql y lo edita el equipo).
const TERMINOS = "📋 *Términos de prueba*\n\n• No hay reembolsos.\n• Cambio con 15 días: sin costo.\n• Cambio de 4 a 1 día: $ 150.000.";
const ANTES = "✨ *Antes de reservar (prueba)*\n\n🕒 Check-in viernes hasta las 9:00 p. m.\n🛁 Volver a llenar el jacuzzi: $ 40.000.";
const SALDO = "🗓️ El saldo se paga un día antes del check-in.";
const CAMBIOS = "🔄 Reprogramas una vez sin costo con 15 días o más.\n🚫 No hay reembolsos.";

function sembrarPoliticas(filas: { clave: string; contenido: string; activo?: boolean }[]) {
  const p = filasDe("politicas");
  p.length = 0;
  for (const f of filas) p.push({ titulo: null, activo: true, ...f });
  // El repo cachea 30s: sin esto, el caso siguiente leería lo que sembró el anterior.
  invalidarCachePoliticas();
}

function sembrarReserva() {
  const r = filasDe("reservas");
  r.length = 0;
  r.push({ id: RESERVA, cliente_id: 1, fecha_reservada: "2026-10-10", numero_huespedes: 2, planes: { nombre: "PLAN INTERMEDIO" } });

  const c = filasDe("clientes");
  c.length = 0;
  c.push({ id: 1, nombre: "Camila Restrepo", celular: "3200000777" });

  const v = filasDe("v_estado_cuenta");
  v.length = 0;
  v.push({
    reserva_id: RESERVA, cliente_id: 1, cliente: "Camila Restrepo", celular: "3200000777",
    fecha_checkin: "2026-10-10", total: TOTAL, pagado: 0, saldo: TOTAL,
    estado_pago: "pendiente", estado_reserva: "borrador", num_pagos: 0,
  });

  filasDe("pagos").length = 0;
  filasDe("bloqueos_temporales").length = 0;
  filasDe("mensajes").length = 0;
  enviados.length = 0;
}

const CTX = { channel: "whatsapp", externalId: CHAT };

interface Caso {
  nombre: string;
  detalle: string;
  correr: () => Promise<string[]>;
}

const CASOS: Caso[] = [
  {
    nombre: "P1. consultar_politicas devuelve el texto de la base, carácter por carácter",
    detalle: "Si el texto llega recortado o 'mejorado', el cliente lee una condición que no es la del negocio.",
    correr: async () => {
      const fallas: string[] = [];
      sembrarPoliticas([
        { clave: "terminos_reserva", contenido: TERMINOS },
        { clave: "antes_de_reservar", contenido: ANTES },
      ]);

      const reservas = await consultarPoliticasTool.handler({ tema: "reservas" }, CTX);
      if (reservas.reply_to_user !== TERMINOS) {
        fallas.push(`tema="reservas" no devolvió el texto exacto de la tabla. Devolvió: ${JSON.stringify(reservas.reply_to_user)}`);
      }

      const estadia = await consultarPoliticasTool.handler({ tema: "estadia" }, CTX);
      if (estadia.reply_to_user !== ANTES) {
        fallas.push(`tema="estadia" no devolvió el texto exacto de la tabla. Devolvió: ${JSON.stringify(estadia.reply_to_user)}`);
      }

      const todo = await consultarPoliticasTool.handler({ tema: "todo" }, CTX);
      if (!todo.reply_to_user?.includes(TERMINOS) || !todo.reply_to_user?.includes(ANTES)) {
        fallas.push('tema="todo" no trajo las dos políticas completas');
      }

      // Esta bandera es la que impide que el modelo reescriba el texto (ver runTurn.ts).
      if (consultarPoliticasTool.permitirRedaccion !== false) {
        fallas.push("la herramienta NO está marcada como texto literal: el modelo podría reformular plazos y montos");
      }
      return fallas;
    },
  },
  {
    nombre: "P2. Sin políticas cargadas: deriva al equipo, no se las inventa",
    detalle: "Si nadie corrió el .sql, el bot tiene que decir que lo confirma — jamás improvisar una condición.",
    correr: async () => {
      const fallas: string[] = [];
      sembrarPoliticas([]);

      const r = await consultarPoliticasTool.handler({ tema: "reservas" }, CTX);
      const texto = r.reply_to_user ?? "";
      if (/reembolso|15 días|150\.000|no generamos/i.test(texto)) {
        fallas.push(`se inventó una política sin tenerla en la base: "${texto}"`);
      }
      if (!/confirmar|equipo/i.test(texto)) {
        fallas.push(`no derivó al equipo cuando no hay política cargada: "${texto}"`);
      }
      if ((r.result as { ok?: boolean })?.ok !== false) {
        fallas.push("el result no dejó marcado que no hay políticas cargadas (el equipo no se enteraría del problema)");
      }
      return fallas;
    },
  },
  {
    nombre: "P3. Una política desactivada no se le manda al cliente",
    detalle: "`activo = false` es como el equipo apaga una política sin borrarla.",
    correr: async () => {
      const fallas: string[] = [];
      sembrarPoliticas([{ clave: "terminos_reserva", contenido: TERMINOS, activo: false }]);

      const r = await consultarPoliticasTool.handler({ tema: "reservas" }, CTX);
      if (r.reply_to_user === TERMINOS) fallas.push("mandó una política que estaba desactivada");
      return fallas;
    },
  },
  {
    nombre: "P4. El link de pago del abono lleva las condiciones ANTES de pagar",
    detalle: "Era el pedido de Daniel: en vez de 'de eso hablamos más adelante', las condiciones reales.",
    correr: async () => {
      const fallas: string[] = [];
      sembrarReserva();
      sembrarPoliticas([
        { clave: "saldo_pendiente", contenido: SALDO },
        { clave: "cambios_corta", contenido: CAMBIOS },
      ]);

      const r = await enviarDatosPagoTool.handler({ reserva_id: RESERVA, modalidad: "abono" }, CTX);
      const texto = r.reply_to_user ?? "";

      if (!texto.includes(SALDO)) fallas.push("el mensaje del link no dice cuándo se paga el saldo");
      if (!texto.includes(CAMBIOS)) fallas.push("el mensaje del link no trae la política de cambios y reembolsos");
      if (/de eso hablamos más adelante/i.test(texto)) fallas.push("todavía tiene el texto viejo ('de eso hablamos más adelante')");
      if (/mándame el comprobante/i.test(texto)) fallas.push("le vuelve a pedir el comprobante (el bot ya verifica solo con Bold)");
      if (!/politicas|políticas/i.test(texto)) fallas.push("no le anuncia al cliente que son las políticas de reserva");
      return fallas;
    },
  },
  {
    nombre: "P5. Si el equipo edita la política en la tabla, cambia lo que lee el cliente",
    detalle: "Es el sentido de tenerla en la base: cambiar un plazo no puede exigir tocar código.",
    correr: async () => {
      const fallas: string[] = [];
      sembrarReserva();
      const EDITADA = "🗓️ NUEVO: el saldo se paga el mismo día del check-in, en la recepción.";
      sembrarPoliticas([
        { clave: "saldo_pendiente", contenido: EDITADA },
        { clave: "cambios_corta", contenido: CAMBIOS },
      ]);

      const r = await enviarDatosPagoTool.handler({ reserva_id: RESERVA, modalidad: "abono" }, CTX);
      const texto = r.reply_to_user ?? "";
      if (!texto.includes(EDITADA)) fallas.push("el mensaje siguió con la política vieja después de editarla en la tabla");
      if (texto.includes(SALDO)) fallas.push("quedó texto de la política anterior (¿cache que no se invalidó?)");
      return fallas;
    },
  },
  {
    nombre: "P6. El aviso automático del pago también usa la política de la base",
    detalle: "Es el mensaje que sale solo cuando Bold confirma — no puede quedarse con el texto viejo.",
    correr: async () => {
      const fallas: string[] = [];
      const conSaldo = textoDeConfirmacion({
        nombre: "Camila", plan: "PLAN INTERMEDIO", fecha: "10 de octubre",
        pagado: 350000, saldo: 350000, politicaSaldo: SALDO,
      });
      if (!conSaldo.includes(SALDO)) fallas.push("el aviso automático no trae la política del saldo");
      if (/según las condiciones del plan/i.test(conSaldo)) fallas.push("el aviso automático sigue con el texto viejo");

      // Sin política cargada el mensaje tiene que salir igual: el aviso del pago es lo importante.
      const sinPolitica = textoDeConfirmacion({
        nombre: "Camila", plan: "PLAN INTERMEDIO", fecha: "10 de octubre",
        pagado: 350000, saldo: 350000, politicaSaldo: null,
      });
      if (!/Queda un saldo/i.test(sinPolitica)) fallas.push("sin política cargada, el aviso del pago se rompió");

      // Pago total: no hay saldo del que hablar, así que no debe aparecer nada del saldo.
      const total = textoDeConfirmacion({
        nombre: "Camila", plan: "PLAN INTERMEDIO", fecha: "10 de octubre",
        pagado: TOTAL, saldo: 0, politicaSaldo: SALDO,
      });
      if (total.includes(SALDO)) fallas.push("habla del saldo pendiente en un pago que ya quedó completo");
      return fallas;
    },
  },
];

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA — políticas oficiales del glamping (tabla `politicas`)");
  console.log("█".repeat(92));

  let fallos = 0;
  for (const caso of CASOS) {
    console.log("\n" + "─".repeat(92));
    console.log(`CASO ${caso.nombre}`);
    console.log(`  ${caso.detalle}`);
    console.log("─".repeat(92));

    let fallas: string[] = [];
    try {
      fallas = await caso.correr();
    } catch (e) {
      fallas = [`excepción: ${(e as Error).message}`];
    }

    if (fallas.length) {
      for (const f of fallas) console.log(`  ❌ ${f}`);
      fallos++;
    } else {
      console.log("  ✅ el caso pasó");
    }
  }

  // Para que quede a la vista en el log cómo le llega el mensaje al cliente.
  sembrarReserva();
  sembrarPoliticas([
    { clave: "saldo_pendiente", contenido: SALDO },
    { clave: "cambios_corta", contenido: CAMBIOS },
  ]);
  const muestra = await enviarDatosPagoTool.handler({ reserva_id: RESERVA, modalidad: "abono" }, CTX);
  console.log("\n" + "─".repeat(92));
  console.log("ASÍ LE LLEGA EL MENSAJE DEL LINK AL CLIENTE (con políticas de prueba):");
  console.log("─".repeat(92));
  console.log((muestra.reply_to_user ?? "").split("\n").map((l) => "  | " + l).join("\n"));

  console.log("\n" + "█".repeat(92));
  if (fallos === 0) console.log(`  RESULTADO: ✅ ${CASOS.length}/${CASOS.length} casos pasaron.`);
  else {
    console.log(`  RESULTADO: ❌ ${fallos} de ${CASOS.length} casos fallaron.`);
    process.exitCode = 1;
  }
  console.log("█".repeat(92) + "\n");
}

main().catch((e) => {
  console.error("Error corriendo la prueba:", e);
  process.exitCode = 1;
});
