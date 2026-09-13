/**
 * PRUEBA: cuando Bold confirma el pago, el cliente se entera SOLO (sin mandar comprobante).
 *
 * Es lo que faltaba: el webhook de Bold ya actualizaba la base, pero nadie le escribía al
 * cliente, así que desde su lado pagar y no recibir nada se siente como que el pago se perdió.
 *
 * Acá se prueba `avisarPagoConfirmado` con la base y el canal simulados, verificando que:
 *   - le escribe al chat correcto (lo resuelve desde la reserva -> cliente -> celular);
 *   - las cifras son las de la base;
 *   - le dice explícitamente que NO hace falta el comprobante;
 *   - el mensaje queda guardado, para que el bot no le vuelva a pedir el pago después;
 *   - si no puede resolver el chat, no explota ni manda nada a ciegas.
 */
// Igual que en las demás pruebas: hace falta un import DINÁMICO de fakes.js para que estas env
// vars queden puestas ANTES de que supabase.ts las lea — un import estático se resuelve antes
// que cualquier statement de este archivo, sin importar en qué línea esté escrito.
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false"; // sin Redis en esta prueba

import { registerChannel } from "../src/channels/registry.js";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");

instalarSupabaseFalso();

const enviados: { to: string; text: string }[] = [];
registerChannel({
  name: "whatsapp",
  async send(msg: { to: string; text?: string }) {
    enviados.push({ to: msg.to, text: msg.text ?? "" });
  },
});

const { avisarPagoConfirmado } = await import("../src/core/pipeline/avisarPago.js");

const CHAT = "+573212191805";
const PLAN = "PLAN UNA PERSONA UNA NOCHE DOMO CLASICO O CHALET";

function formato(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

/** Deja la base como queda justo después de que el webhook registró el pago. */
function sembrar(opts: { total: number; pagado: number; conConversacion?: boolean; celular?: string }) {
  const t = filasDe("reservas");
  t.length = 0;
  t.push({ id: 5, cliente_id: 1, fecha_reservada: "2026-09-15", numero_huespedes: 1, planes: { nombre: PLAN } });

  const c = filasDe("clientes");
  c.length = 0;
  c.push({ id: 1, nombre: "Daniel Felipe Pataquiva Alarcón", celular: opts.celular ?? "3212191805" });

  const e = filasDe("estado_conversacion");
  e.length = 0;
  if (opts.conConversacion !== false) {
    e.push({ canal: "whatsapp", external_id: CHAT, last_agent: "pagos", updated_at: new Date().toISOString() });
  }

  const v = filasDe("v_estado_cuenta");
  v.length = 0;
  v.push({
    reserva_id: 5, cliente_id: 1, cliente: "Daniel Felipe Pataquiva Alarcón", celular: opts.celular ?? "3212191805",
    fecha_checkin: "2026-09-15", total: opts.total, pagado: opts.pagado, saldo: opts.total - opts.pagado,
    estado_pago: opts.pagado >= opts.total ? "pagada_total" : "con_anticipo", estado_reserva: "confirmada", num_pagos: 1,
  });

  filasDe("mensajes").length = 0;
  enviados.length = 0;
}

interface Caso { nombre: string; correr: () => Promise<string[]> }

const CASOS: Caso[] = [
  {
    nombre: "A. Abonó el 50%: se le confirma y se le dice cuánto queda",
    correr: async () => {
      sembrar({ total: 5000, pagado: 2500 });
      await avisarPagoConfirmado({ reservaId: 5, totalPagado: 2500, saldoPendiente: 2500 });
      const fallas: string[] = [];
      const msg = enviados[0];
      if (!msg) return ["no se le escribió nada al cliente"];
      if (msg.to !== CHAT) fallas.push(`le escribió a "${msg.to}" en vez de a ${CHAT}`);
      if (!msg.text.includes(formato(2500))) fallas.push(`el mensaje no dice el monto pagado (${formato(2500)})`);
      if (!/comprobante/i.test(msg.text)) fallas.push("no le aclara que NO hace falta el comprobante");
      if (!msg.text.includes(PLAN)) fallas.push("no nombra el plan");
      if (!/15 de septiembre/.test(msg.text)) fallas.push("no dice la fecha de la reserva");
      if (/confirmada/.test(msg.text)) fallas.push('dice "confirmada" aunque todavía queda saldo');
      const guardado = filasDe("mensajes").some((m) => m.content === msg.text && m.role === "assistant");
      if (!guardado) fallas.push("el mensaje no quedó guardado en `mensajes` (el bot podría volver a pedir el pago)");
      console.log("\n  ── MENSAJE AL CLIENTE ──");
      console.log(msg.text.split("\n").map((l) => "  | " + l).join("\n"));
      return fallas;
    },
  },
  {
    nombre: "B. Pagó todo: se le confirma la reserva y no se le inventa un saldo",
    correr: async () => {
      sembrar({ total: 5000, pagado: 5000 });
      await avisarPagoConfirmado({ reservaId: 5, totalPagado: 5000, saldoPendiente: 0 });
      const fallas: string[] = [];
      const msg = enviados[0];
      if (!msg) return ["no se le escribió nada al cliente"];
      if (!msg.text.includes(formato(5000))) fallas.push(`el mensaje no dice el monto pagado (${formato(5000)})`);
      if (!/confirmada/.test(msg.text)) fallas.push("no le dice que la reserva quedó confirmada");
      if (/saldo de \$/.test(msg.text)) fallas.push("le menciona un saldo pendiente que ya no existe");
      console.log("\n  ── MENSAJE AL CLIENTE ──");
      console.log(msg.text.split("\n").map((l) => "  | " + l).join("\n"));
      return fallas;
    },
  },
  {
    nombre: "C. No se puede resolver el chat: no explota ni manda nada a ciegas",
    correr: async () => {
      sembrar({ total: 5000, pagado: 2500, conConversacion: false });
      await avisarPagoConfirmado({ reservaId: 5, totalPagado: 2500, saldoPendiente: 2500 });
      return enviados.length > 0 ? ["mandó un mensaje sin saber a qué conversación pertenece"] : [];
    },
  },
  {
    nombre: "D. Sin monto válido no se le escribe nada",
    correr: async () => {
      sembrar({ total: 5000, pagado: 0 });
      await avisarPagoConfirmado({ reservaId: 5, totalPagado: 0, saldoPendiente: 5000 });
      return enviados.length > 0 ? ["le confirmó un pago de $0"] : [];
    },
  },
];

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA — el bot avisa solo que el pago entró (sin comprobante)");
  console.log("█".repeat(92));

  let fallos = 0;
  for (const caso of CASOS) {
    console.log("\n" + "─".repeat(92));
    console.log(`CASO ${caso.nombre}`);
    console.log("─".repeat(92));
    const fallas = await caso.correr();
    if (fallas.length) { for (const f of fallas) console.log(`  ❌ ${f}`); fallos++; }
    else console.log("  ✅ el caso pasó");
  }

  console.log("\n" + "█".repeat(92));
  if (fallos === 0) console.log(`  RESULTADO: ✅ ${CASOS.length}/${CASOS.length} casos pasaron.`);
  else { console.log(`  RESULTADO: ❌ ${fallos} de ${CASOS.length} casos fallaron.`); process.exitCode = 1; }
  console.log("█".repeat(92) + "\n");
}

main().catch((e) => { console.error("Error corriendo la prueba:", e); process.exitCode = 1; });
