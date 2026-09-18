/**
 * PRUEBA DE PUNTA A PUNTA: "el bot nunca puede mandar un precio que no esté en la base".
 *
 * Corre el bot ENTERO (el mismo `handleInbound` que usa el worker de WhatsApp: orquestador,
 * selección de agente, prompts reales, herramientas reales, chequeo anti-alucinación y envío)
 * contra los datos REALES de la base, y le pone enfrente un modelo GUIONADO que se porta lo
 * peor posible — incluyendo el comportamiento exacto que se vio en los logs de la prueba real
 * del 2026-09-11 (el bot repitiendo $590.000 cuando en la base ya decía $1.000).
 *
 * La conversación arranca CONTAMINADA a propósito: el historial ya trae al bot diciendo
 * "$ 590.000" tres veces, igual que en el WhatsApp real. Es el peor escenario para el modelo.
 *
 * Lo único simulado es lo que esta sesión no puede alcanzar por red (Supabase, OpenRouter) y
 * el envío final por WhatsApp. La lógica que se prueba es 100% la de producción.
 */
process.env.FOLLOWUP_ENABLED = "false"; // sin Redis en esta prueba
process.env.LOBBYPMS_API_TOKEN = "";
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";

import type { Guion } from "./fakes.js";
import { PRECIO_REAL_ENTRE_SEMANA, PRECIO_REAL_ENTRE_SEMANA_TEXTO, PRECIO_VIEJO_EN_DESCRIPCION } from "./datos-reales.js";

// [2026-09-11] OJO: esto tiene que ser un import DINÁMICO, no uno estático de los de arriba.
// En ESM los imports estáticos se resuelven ANTES que cualquier statement del propio archivo,
// aunque estén escritos más abajo en el texto — así que un `import {...} from "./fakes.js"`
// estático haría que supabase.ts (que importa fakes.js) leyera las variables de entorno de
// arriba TODAVÍA vacías, dejando `supabaseConfigured` en false pese al `||=` de acá arriba.
// Con `await import(...)` (dinámico) sí se respeta el orden: primero las env vars, después el
// import. Se comprobó que sin esto la prueba pasaba igual pero mintiendo: corría con
// `supabaseConfigured=false` y el catálogo siempre vacío.
const { instalarSupabaseFalso, instalarModeloFalso, usarGuion, adaptadorFalso, enviados, registroDelModelo, sembrarMensajes, filasDe, simularBaseCaida } = await import("./fakes.js");

instalarSupabaseFalso();
instalarModeloFalso();

const { handleInbound } = await import("../src/core/pipeline/runTurn.js");

const FECHA = "2026-09-15"; // martes -> tarifa de entre semana
const PLAN = "PLAN FAMILIAR 3 PERSONAS";

/** Cifras de dinero de un texto, con el MISMO detector que usa el pipeline. */
function montosEn(texto: string): string[] {
  const out: string[] = [];
  for (const re of [/\$\s?\d[\d.,]*/g, /\b\d{1,3}(?:[.,]\d{3})+\b/g]) {
    for (const m of texto.matchAll(re)) {
      const d = m[0].replace(/\D/g, "");
      if (d.length >= 4) out.push(d);
    }
  }
  return [...new Set(out)];
}

/** El historial contaminado: el bot YA dijo el precio viejo tres veces en esta charla. */
function historialContaminado(externalId: string) {
  const base = Date.parse("2026-09-11T17:00:00Z");
  const m = (role: string, content: string, i: number) => ({
    canal: "whatsapp", external_id: externalId, role, content,
    created_at: new Date(base + i * 60000).toISOString(),
  });
  return [
    m("user", "hola, info del plan familiar para 3", 0),
    m("assistant", `Para el 14 de septiembre el ${PLAN} queda en *$ 590.000* (sin IVA) para las 3 personas.`, 1),
    m("user", "y el 15?", 2),
    m("assistant", `Para el 15 de septiembre, como es entre semana, el ${PLAN} queda en *$ 590.000* (sin IVA).`, 3),
    m("user", "me lo confirmas?", 4),
    m("assistant", `Confirmado: el ${PLAN} entre semana vale *$ 590.000* para 3 personas, sin IVA.`, 5),
  ];
}

// --- Los guiones: cada uno es una forma distinta en que el modelo puede portarse mal --------

const TEXTO_CON_PRECIO_VIEJO =
  `¡Confirmado! 💚 Para el **15 de septiembre** (martes, entre semana) el *${PLAN}* **sí tiene cupo** ✅\n\n` +
  `💰 Valor entre semana (lunes a viernes): **$ 590.000** para 3 personas, sin IVA\n\n¿Dejamos registrada la reserva?`;

const TEXTO_CON_PRECIO_BUENO =
  `¡Confirmado! 💚 Para el **15 de septiembre** (martes, entre semana) el *${PLAN}* **sí tiene cupo** ✅\n\n` +
  `💰 Valor entre semana: **${PRECIO_REAL_ENTRE_SEMANA_TEXTO}** para 3 personas, sin IVA\n\n¿Dejamos registrada la reserva?`;

const TEXTO_CON_PRECIO_INVENTADO =
  `¡Confirmado! Para el 15 de septiembre el ${PLAN} queda en **$ 2.500.000** para 3 personas, sin IVA.`;

const TEXTO_CON_RECARGO_VIEJO =
  `El ${PLAN} entre semana vale **${PRECIO_REAL_ENTRE_SEMANA_TEXTO}**, y los niños mayores de 3 años pagan **$ 50.000** adicionales.`;

interface Caso {
  nombre: string;
  detalle: string;
  guion: Guion;
  /** Qué cifras NO pueden aparecer jamás en lo que se le manda al cliente. */
  prohibidos: string[];
  /** Si se espera que el mensaje final contenga el precio bueno. */
  esperaPrecioBueno?: boolean;
  /** Corre este caso con la base devolviendo vacío (Supabase caído). */
  baseCaida?: boolean;
}

const CASOS: Caso[] = [
  {
    nombre: "A. Contesta de memoria, sin llamar ninguna herramienta",
    detalle: "El bug original: el cliente cambia de fecha y el modelo repite el precio que ya dijo antes.",
    prohibidos: [PRECIO_VIEJO_EN_DESCRIPCION],
    guion: (_l, hop) => {
      if (hop === 1) return { texto: TEXTO_CON_PRECIO_VIEJO };
      // Si lo obligan a llamar la herramienta, la llama bien y después redacta con el dato bueno.
      if (hop === 2) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: FECHA, personas: 3, segmento: "familia" } };
      return { texto: TEXTO_CON_PRECIO_BUENO };
    },
  },
  {
    nombre: "B. Igual que el log real (búsqueda parcial 'familiar' + precio viejo)",
    detalle: "Reproduce hop por hop lo que hizo el modelo en la prueba del 2026-09-11 en WhatsApp.",
    prohibidos: [PRECIO_VIEJO_EN_DESCRIPCION],
    guion: (_l, hop) => {
      if (hop === 1) return { herramienta: "consultar_planes", args: { plan: "familiar", fecha: FECHA, personas: 3, segmento: "familia" } };
      if (hop === 2) return { texto: TEXTO_CON_PRECIO_VIEJO };
      if (hop === 3) return { herramienta: "consultar_planes", args: { fecha: FECHA, nivel: "por_noche", plan: PLAN } };
      return { texto: TEXTO_CON_PRECIO_VIEJO }; // se planta: insiste con el precio viejo
    },
  },
  {
    nombre: "C. Llama bien la herramienta y AUN ASÍ escribe el precio viejo",
    detalle: "El peor caso: el dato bueno lo tiene enfrente y lo ignora, copiando lo que él mismo dijo antes.",
    prohibidos: [PRECIO_VIEJO_EN_DESCRIPCION],
    guion: (_l, hop) => {
      if (hop === 1) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: FECHA, personas: 3, segmento: "familia" } };
      return { texto: TEXTO_CON_PRECIO_VIEJO };
    },
  },
  {
    nombre: "D. Se porta bien (precio de la base)",
    detalle: "Control: el pipeline NO debe romper ni reescribir una respuesta correcta.",
    prohibidos: [PRECIO_VIEJO_EN_DESCRIPCION],
    esperaPrecioBueno: true,
    guion: (_l, hop) => {
      if (hop === 1) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: FECHA, personas: 3, segmento: "familia" } };
      return { texto: TEXTO_CON_PRECIO_BUENO };
    },
  },
  {
    nombre: "E. Se inventa una cifra que no existe en ningún lado",
    detalle: "Alucinación pura: $2.500.000 no está ni en la base ni en la descripción.",
    prohibidos: ["2500000"],
    guion: (_l, hop) => {
      if (hop === 1) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: FECHA, personas: 3, segmento: "familia" } };
      return { texto: TEXTO_CON_PRECIO_INVENTADO };
    },
  },
  {
    nombre: "G. La base se cae y el modelo cotiza igual, de memoria",
    detalle: "Supabase devuelve vacío: no hay NINGÚN dato fresco con qué contrastar. Ni así puede salir un precio.",
    prohibidos: [PRECIO_VIEJO_EN_DESCRIPCION],
    baseCaida: true,
    guion: (_l, hop) => {
      if (hop === 1) return { texto: TEXTO_CON_PRECIO_VIEJO };
      if (hop === 2) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: FECHA } };
      return { texto: TEXTO_CON_PRECIO_VIEJO };
    },
  },
  {
    nombre: "F. Agrega un recargo de niños que ninguna herramienta devolvió",
    detalle: "$50.000 por niño vive en la tabla `recargos`; este turno solo llamó consultar_planes, así que esa cifra no está verificada.",
    prohibidos: ["50000"],
    guion: (_l, hop) => {
      if (hop === 1) return { herramienta: "consultar_planes", args: { plan: PLAN, fecha: FECHA, personas: 3, segmento: "familia" } };
      return { texto: TEXTO_CON_RECARGO_VIEJO };
    },
  },
];

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA DE PUNTA A PUNTA — pipeline real, datos reales, modelo guionado adversarial");
  console.log("█".repeat(92));
  console.log(`  Plan probado           : ${PLAN}`);
  console.log(`  Precio REAL en la base : $${PRECIO_REAL_ENTRE_SEMANA} (entre semana)`);
  console.log(`  Precio VIEJO que el bot ya dijo en esta charla: $${PRECIO_VIEJO_EN_DESCRIPCION} <- no puede salir nunca`);
  console.log(`  Historial de la charla : ya trae al bot diciendo "$ 590.000" 3 veces (igual que en WhatsApp)`);

  let fallos = 0;

  for (const [i, caso] of CASOS.entries()) {
    const externalId = `+57000000000${i}`;
    sembrarMensajes(historialContaminado(externalId));
    simularBaseCaida(Boolean(caso.baseCaida));
    enviados.length = 0;
    usarGuion(caso.guion);

    console.log("\n" + "─".repeat(92));
    console.log(`CASO ${caso.nombre}`);
    console.log(`  ${caso.detalle}`);
    console.log("─".repeat(92));

    try {
      await Promise.race([
        handleInbound({ channel: "whatsapp", externalId, text: `me confirmas el precio del plan familiar 3 para el 15 de septiembre?`, timestamp: new Date().toISOString() }, adaptadorFalso as any),
        new Promise((r) => setTimeout(r, 25000)),
      ]);
    } catch (e) {
      console.log(`  (el turno terminó con excepción, se evalúa igual lo que se alcanzó a enviar): ${(e as Error).message}`);
    }

    console.log("\n  Lo que hizo el modelo:");
    for (const l of registroDelModelo) console.log(`    · ${l}`);

    const entregado = enviados[enviados.length - 1] ?? "(NO SE ENVIÓ NADA)";
    console.log("\n  ── MENSAJE QUE LE LLEGA AL CLIENTE ──");
    console.log(entregado.split("\n").map((l) => "  | " + l).join("\n"));

    const montos = montosEn(entregado);
    console.log(`\n  cifras en el mensaje entregado: ${JSON.stringify(montos)}`);

    const colados = caso.prohibidos.filter((p) => montos.includes(p));
    let ok = colados.length === 0;
    if (!ok) console.log(`  ❌ FALLA: se le mandó al cliente la cifra prohibida ${JSON.stringify(colados)}`);
    else console.log(`  ✅ ninguna cifra prohibida (${JSON.stringify(caso.prohibidos)}) llegó al cliente`);

    if (caso.esperaPrecioBueno) {
      const tiene = montos.includes(String(PRECIO_REAL_ENTRE_SEMANA));
      if (!tiene) { console.log(`  ❌ FALLA: se esperaba ver el precio real $${PRECIO_REAL_ENTRE_SEMANA} y no está`); ok = false; }
      else console.log(`  ✅ el precio real de la base ($${PRECIO_REAL_ENTRE_SEMANA}) llegó intacto`);
    }

    if (!ok) fallos++;
  }

  // [2026-09-17] Comprobación de que la prueba sigue midiendo algo. Antes verificaba lo
  // CONTRARIO: que la descripción de la base trajera el precio viejo, porque el arreglo de
  // entonces era un filtro que lo borraba al vuelo. Ese filtro ya no existe — la descripción se
  // migró al token `$$$$` y la regla nueva es que el bot muestra lo que diga la base. Así que
  // ahora lo que hay que confirmar es que la descripción quedó LIMPIA: si volviera a traer un
  // precio escrito a mano, esa cifra sería legítima para el pipeline y los casos B, C y F
  // pasarían sin probar nada.
  simularBaseCaida(false);
  const crudo = filasDe("planes").find((p) => p.id === 30)?.descripcion ?? "";
  const limpia = !montosEn(crudo).includes(PRECIO_VIEJO_EN_DESCRIPCION) && crudo.includes("$$$$");

  console.log("\n" + "█".repeat(92));
  console.log(
    `  La descripción de la base está migrada a $$$$ y sin precios a mano: ` +
      `${limpia ? "sí (la prueba es válida)" : "NO — la prueba no probaría nada"}`
  );
  if (fallos === 0 && limpia) {
    console.log(`  RESULTADO: ✅ ${CASOS.length}/${CASOS.length} casos pasaron. Ningún precio fuera de la base llegó al cliente.`);
  } else {
    console.log(`  RESULTADO: ❌ ${fallos} de ${CASOS.length} casos fallaron.`);
    process.exitCode = 1;
  }
  console.log("█".repeat(92) + "\n");
}

main().catch((e) => { console.error("Error corriendo la prueba:", e); process.exitCode = 1; });
