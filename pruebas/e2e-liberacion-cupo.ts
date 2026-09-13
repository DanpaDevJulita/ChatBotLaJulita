/**
 * PRUEBA: antes de soltar un cupo por vencimiento, el bot verifica el pago por lo bajo.
 *
 * El caso que se quiere evitar (y que pasaba): el cliente paga, el webhook de Bold no llega, el
 * cliente no escribe nada, se vencen los 10 minutos, y el bot le libera el cupo Y le escribe
 * "liberé el cupo que te había apartado". Cupo pagado perdido y cliente furioso, todo junto.
 *
 * Se verifica que:
 *   - si Bold dice que el pago entró: NO se libera, el bloqueo queda confirmado, y el cliente
 *     recibe la confirmación (no el mensaje de liberación);
 *   - si no hay pago: todo sigue exactamente como antes (se libera y se le avisa);
 *   - si Bold no responde: se libera igual — un Bold caído no puede dejar cupos trabados para
 *     siempre — y nunca se da por pagado lo que no se pudo verificar.
 */
// [2026-09-11] TODAS estas env vars tienen que quedar puestas ANTES de importar fakes.js (y con
// él, supabase.ts / asegurarCupo.ts / lobbypms.ts). Por eso el import de fakes.js de acá abajo es
// DINÁMICO: un import estático se resuelve antes que cualquier statement de este archivo, sin
// importar en qué línea del texto esté escrito, y estas variables llegarían tarde.
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.BOLD_API_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false"; // sin Redis en esta prueba
// Los reintentos internos (asegurarCupoConReintentos) se leen al importar asegurarCupo.ts. Se
// deja el token "puesto" (para que lobbypms.ts sí intente las llamadas, que acá van todas a
// lobbyFalso) y los reintentos cortos y rápidos, para no hacer esperar la prueba los minutos de
// producción.
process.env.LOBBYPMS_API_TOKEN = "token-de-prueba";
process.env.MAX_INTENTOS_CUPO = "3";
process.env.ESPERA_ENTRE_INTENTOS_CUPO_MS = "5";
// Para poder comprobar que SÍ (o NO) se escaló: notificarEscalamiento manda por el mismo canal
// "whatsapp" que el cliente, a estos números — si queda vacío, ni se intenta avisar al equipo.
process.env.OWNER_WHATSAPP_NUMBERS = "3210000000";

import { registerChannel } from "../src/channels/registry.js";

const {
  instalarSupabaseFalso, instalarBoldFalso, boldResponderaEstado, filasDe, rpcsLlamados, consultasABold,
  instalarLobbyFalso, lobbyResponderaDisponibilidad, lobbyResponderaBlock, consultasDisponibilidadLobby,
  bloqueosCreadosLobby,
} = await import("./fakes.js");

instalarSupabaseFalso();
instalarBoldFalso();
instalarLobbyFalso();

const enviados: string[] = [];
const adaptador = { name: "whatsapp", async send(m: { to: string; text?: string }) { enviados.push(m.text ?? ""); } };
registerChannel(adaptador);

const { ejecutarLiberacionBloqueo } = await import("../src/core/pipeline/bloqueo.js");

const RESERVA = 91;
const BLOQUEO = 55;
const CHAT = "+573212191805";
const TOTAL = 760000;
const ABONO = 380000;
const REF = `res${RESERVA}-abono-1789000000000`;

function sembrar(opts: { conCupoEnLobby?: boolean; estadoBloqueo?: string } = {}) {
  const r = filasDe("reservas"); r.length = 0;
  r.push({ id: RESERVA, cliente_id: 1, fecha_reservada: "2026-09-15", numero_huespedes: 3, planes: { nombre: "PLAN FAMILIAR 3 PERSONAS" } });

  const c = filasDe("clientes"); c.length = 0;
  c.push({ id: 1, nombre: "Daniel Pataquiva", celular: "3212191805" });

  const e = filasDe("estado_conversacion"); e.length = 0;
  e.push({ canal: "whatsapp", external_id: CHAT, last_agent: "pagos", updated_at: new Date().toISOString() });

  const v = filasDe("v_estado_cuenta"); v.length = 0;
  v.push({ reserva_id: RESERVA, cliente_id: 1, cliente: "Daniel Pataquiva", celular: "3212191805",
           fecha_checkin: "2026-09-15", total: TOTAL, pagado: 0, saldo: TOTAL,
           estado_pago: "pendiente", estado_reserva: "borrador", num_pagos: 0 });

  const p = filasDe("pagos"); p.length = 0;
  p.push({ id: 1, reserva_id: RESERVA, tipo: "abono", valor: ABONO, referencia: REF, estado: "pendiente",
           payment_link: "LNK_PRUEBA", link_url: "https://checkout.bold.co/payment/LNK_PRUEBA" });

  const b = filasDe("bloqueos_temporales"); b.length = 0;
  b.push({ id: BLOQUEO, canal: "whatsapp", external_id: CHAT, estado: opts.estadoBloqueo ?? "pendiente", avisado: false,
           clase_domo: "clasico", capacidad: 4, fecha_entrada: "2026-09-15", noches: 1,
           cliente_id: 1, personas: 3, valor_total: TOTAL, ninos: 0,
           lobby_block_id: opts.conCupoEnLobby === false ? null : 7001,
           lobby_category_id: 33, lobby_booking_id: null, lobby_room_id: null,
           expira_en: new Date(Date.now() - 60000).toISOString() });

  filasDe("mensajes").length = 0;
  enviados.length = 0;
  rpcsLlamados.length = 0;
  consultasABold.length = 0;
  consultasDisponibilidadLobby.length = 0;
  bloqueosCreadosLobby.length = 0;
  lobbyResponderaDisponibilidad([5]);
  lobbyResponderaBlock(true);
}

function bloqueo() { return filasDe("bloqueos_temporales").find((b) => b.id === BLOQUEO); }

/** El aviso al equipo (notificarEscalamiento) manda por el mismo canal, así que se distingue por el 🆘. */
function huboEscalamiento(): boolean { return enviados.some((m) => m.startsWith("🆘")); }
/** El mensaje que sí le llegó al CLIENTE (no el aviso interno al equipo). */
function mensajeCliente(): string { return [...enviados].reverse().find((m) => !m.startsWith("🆘")) ?? ""; }

interface Caso { nombre: string; detalle: string; preparar: () => void; revisar: () => string[] }

const CASOS: Caso[] = [
  {
    nombre: "L1. El cliente YA PAGÓ (y no dijo nada): no se le libera el cupo",
    detalle: "El caso que rompía. Bold dice PAID, así que el cupo se conserva y se le confirma.",
    preparar: () => { sembrar(); boldResponderaEstado({ status: "PAID", transaction_id: "TX-99", total: ABONO, reference: REF }); },
    revisar: () => {
      const fallas: string[] = [];
      const msg = mensajeCliente();
      if (/liberé el cupo/i.test(msg)) fallas.push("LE LIBERÓ UN CUPO YA PAGADO y se lo dijo");
      if (bloqueo()?.estado === "liberado") fallas.push("el bloqueo quedó liberado pese al pago");
      if (bloqueo()?.estado !== "confirmado") fallas.push(`el bloqueo quedó en "${bloqueo()?.estado}" en vez de confirmado`);
      if (!rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("no registró el pago que encontró");
      if (!/Confirmado/i.test(msg)) fallas.push("no le confirmó el pago al cliente");
      if (huboEscalamiento()) fallas.push("escaló al equipo sin ninguna necesidad — el cupo estaba bien");
      console.log("  ── MENSAJE AL CLIENTE ──");
      console.log(msg.split("\n").map((l) => "  | " + l).join("\n"));
      return fallas;
    },
  },
  {
    nombre: "L2. No hay pago: todo sigue igual que antes",
    detalle: "El flujo normal no se puede haber roto: se libera el cupo y se le avisa.",
    preparar: () => { sembrar(); boldResponderaEstado({ status: "ACTIVE" }); },
    revisar: () => {
      const fallas: string[] = [];
      const msg = mensajeCliente();
      if (!/liberé el cupo/i.test(msg)) fallas.push("no le avisó que se liberó el cupo");
      if (bloqueo()?.estado !== "liberado") fallas.push(`el bloqueo quedó en "${bloqueo()?.estado}" en vez de liberado`);
      if (rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("registró un pago que no existe");
      if (consultasABold.length === 0) fallas.push("ni siquiera le preguntó a Bold antes de liberar");
      if (huboEscalamiento()) fallas.push("escaló al equipo sin que hubiera ni pago ni problema");
      return fallas;
    },
  },
  {
    nombre: "L3. Bold no responde: se libera igual, sin inventar un pago",
    detalle: "Un Bold caído no puede dejar cupos trabados para siempre, ni dar pagos por hechos.",
    preparar: () => { sembrar(); boldResponderaEstado(null); },
    revisar: () => {
      const fallas: string[] = [];
      const msg = mensajeCliente();
      if (!/liberé el cupo/i.test(msg)) fallas.push("el cupo quedó trabado porque Bold no respondió");
      if (rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("dio por pagado algo que no pudo consultar");
      if (huboEscalamiento()) fallas.push("escaló al equipo por un Bold caído, sin siquiera saber si hay pago");
      return fallas;
    },
  },
  {
    nombre: "L4. Pago tardío y LobbyPMS confirma que YA NO HAY disponibilidad: se escala de una",
    detalle:
      "El caso real del 2026-09-11, con la disponibilidad ya comprobada en 0. El bot no puede decirle " +
      "'reserva confirmada' — le avisa que está validando la fecha, y como LobbyPMS SÍ contestó (no hay " +
      "nada), no tiene sentido reintentar: escala al equipo de una, sin dar vueltas de más.",
    preparar: () => {
      sembrar({ conCupoEnLobby: false, estadoBloqueo: "liberado" });
      lobbyResponderaDisponibilidad([0]);
      boldResponderaEstado({ status: "PAID", transaction_id: "TX-77", total: ABONO, reference: REF });
    },
    revisar: () => {
      const fallas: string[] = [];
      const msg = mensajeCliente();
      if (/queda confirmada|queda apartada|reserva confirmada/i.test(msg)) {
        fallas.push("LE CONFIRMÓ LA RESERVA sin tener el cupo asegurado en LobbyPMS");
      }
      if (!/estoy confirmando|validando|disponible/i.test(msg)) fallas.push("no le dice que está validando la fecha");
      if (!new RegExp("380.000").test(msg)) fallas.push("no le reconoce el pago que hizo");
      if (!rpcsLlamados.some((r) => r.nombre === "fn_registrar_pago_aprobado")) fallas.push("no registró el pago");
      if (!huboEscalamiento()) fallas.push("NO escaló al equipo, y acá sí hacía falta (no hay disponibilidad y ya pagó)");
      if (consultasDisponibilidadLobby.length !== 1) {
        fallas.push(`reintentó (${consultasDisponibilidadLobby.length} consultas) cuando LobbyPMS ya había contestado que no hay nada`);
      }
      if (bloqueosCreadosLobby.length !== 0) fallas.push("intentó volver a bloquear un cupo que no existe");
      console.log("  ── MENSAJE AL CLIENTE ──");
      console.log(msg.split("\n").map((l) => "  | " + l).join("\n"));
      return fallas;
    },
  },
  {
    nombre: "L5. LobbyPMS no contesta al toque, pero SÍ tenía cupo: se reintenta y no hace falta escalar",
    detalle:
      "Lo que pidió el equipo: 'vos mismo hacés la validación interna, y si sigue disponible, apartás vos'. " +
      "La primera consulta a LobbyPMS falla (un tropiezo, no una respuesta) pero la segunda sí contesta " +
      "que hay cupo — el bot lo vuelve a tomar SOLO, sin molestar a nadie.",
    preparar: () => {
      sembrar({ conCupoEnLobby: false, estadoBloqueo: "liberado" });
      lobbyResponderaDisponibilidad([null, 5]);
      boldResponderaEstado({ status: "PAID", transaction_id: "TX-78", total: ABONO, reference: REF });
    },
    revisar: () => {
      const fallas: string[] = [];
      const msg = mensajeCliente();
      if (huboEscalamiento()) fallas.push("escaló al equipo cuando el reintento SÍ logró asegurar el cupo");
      if (!/confirmada|apartada/i.test(msg) || /estoy confirmando/i.test(msg)) {
        fallas.push("no le confirmó la reserva pese a haber vuelto a tomar el cupo");
      }
      if (bloqueo()?.estado !== "confirmado") fallas.push(`el bloqueo quedó en "${bloqueo()?.estado}" en vez de confirmado`);
      if (consultasDisponibilidadLobby.length !== 2) {
        fallas.push(`reintentó ${consultasDisponibilidadLobby.length} veces (esperaba exactamente 2: la que falla y la que contesta)`);
      }
      if (bloqueosCreadosLobby.length !== 1) fallas.push("no volvió a bloquear el cupo en LobbyPMS pese a haber disponibilidad");
      console.log("  ── MENSAJE AL CLIENTE ──");
      console.log(msg.split("\n").map((l) => "  | " + l).join("\n"));
      return fallas;
    },
  },
  {
    nombre: "L6. LobbyPMS no contesta NUNCA: se agotan los reintentos y ahí SÍ se escala",
    detalle:
      "El último recurso de verdad: se le preguntó varias veces y nunca se pudo saber. No se puede dejar " +
      "la plata del cliente sin resolver para siempre, así que después de agotar los reintentos, se escala.",
    preparar: () => {
      sembrar({ conCupoEnLobby: false, estadoBloqueo: "liberado" });
      lobbyResponderaDisponibilidad([null, null, null]);
      boldResponderaEstado({ status: "PAID", transaction_id: "TX-79", total: ABONO, reference: REF });
    },
    revisar: () => {
      const fallas: string[] = [];
      const msg = mensajeCliente();
      if (/queda confirmada|queda apartada|reserva confirmada/i.test(msg)) {
        fallas.push("LE CONFIRMÓ LA RESERVA sin haber podido verificar nunca el cupo");
      }
      if (!huboEscalamiento()) fallas.push("NO escaló al equipo pese a agotar los reintentos sin poder verificar nada");
      if (consultasDisponibilidadLobby.length !== 3) {
        fallas.push(`hizo ${consultasDisponibilidadLobby.length} intentos en vez de agotar los 3 antes de escalar`);
      }
      return fallas;
    },
  },
];

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA — no liberar un cupo que ya está pagado");
  console.log("█".repeat(92));

  let fallos = 0;
  for (const caso of CASOS) {
    caso.preparar();
    console.log("\n" + "─".repeat(92));
    console.log(`CASO ${caso.nombre}`);
    console.log(`  ${caso.detalle}`);
    console.log("─".repeat(92));

    try {
      await ejecutarLiberacionBloqueo({ bloqueoId: BLOQUEO, canal: "whatsapp", externalId: CHAT }, adaptador as any);
    } catch (e) {
      console.log(`  (excepción): ${(e as Error).message}`);
    }

    console.log(`  consultas a Bold: ${consultasABold.length} · estado del bloqueo: ${bloqueo()?.estado}`);
    const fallas = caso.revisar();
    if (fallas.length) { for (const f of fallas) console.log(`  ❌ ${f}`); fallos++; }
    else console.log("  ✅ el caso pasó");
  }

  console.log("\n" + "█".repeat(92));
  if (fallos === 0) console.log(`  RESULTADO: ✅ ${CASOS.length}/${CASOS.length} casos pasaron.`);
  else { console.log(`  RESULTADO: ❌ ${fallos} de ${CASOS.length} casos fallaron.`); process.exitCode = 1; }
  console.log("█".repeat(92) + "\n");
}

main().catch((e) => { console.error("Error corriendo la prueba:", e); process.exitCode = 1; });
