/**
 * PRUEBA: reconocer a un cliente que ya reservó antes (2026-09-14).
 *
 * Lo que encontró Daniel probando en vivo: "con mi número ya había hecho más reservas,
 * debería recordar información y en vez de volver a pedir datos, preguntar si los datos son
 * correctos, sino editar." `registrar_datos_reserva` no tenía ninguna forma de saber que ESE
 * celular ya era un cliente guardado — le pedía todo desde cero a cualquiera, aunque el bot ya
 * tuviera su nombre y documento de una reserva anterior.
 *
 * Esto prueba la herramienta nueva `consultar_cliente_conocido` (src/agentes/reservas/herramientas/
 * clienteConocido.ts) y la función de base que la sostiene (`buscarClienteConocidoPorCelular` en
 * reservasRepo.ts): que encuentra al cliente correcto por el celular DE LA CONVERSACIÓN (nunca
 * por lo que diga el cliente), que nunca inventa un nombre o documento que no esté en la base, y
 * que un celular sin historial no rompe nada (cliente nuevo, sigue el flujo de siempre).
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const { consultarClienteConocidoTool } = await import("../src/agentes/reservas/herramientas/clienteConocido.js");

let fallos = 0;
function verificar(nombre: string, condicion: boolean, detalle: string): void {
  if (condicion) {
    console.log(`  ✅ ${nombre}`);
  } else {
    console.log(`  ❌ ${nombre} — ${detalle}`);
    fallos++;
  }
}

function limpiar(): void {
  filasDe("clientes").length = 0;
  filasDe("tipo_documento").length = 0;
}

console.log("\n" + "█".repeat(92));
console.log("  PRUEBA — reconocer a un cliente que ya reservó antes");
console.log("█".repeat(92));

// --- CASO 1: cliente conocido, celular con formato distinto al guardado (+57 vs sin él) -------
console.log("\n" + "─".repeat(92));
console.log("CASO 1. Cliente conocido: no le vuelve a pedir los datos, se los confirma");
console.log("─".repeat(92));
limpiar();
filasDe("tipo_documento").push({ id: 1, nombre: "Cédula de ciudadanía", seudonimo: "CC" });
filasDe("clientes").push({
  id: 501,
  nombre: "Daniel Pataquiva",
  tipo_documento_id: 1,
  numero_documento: "10009040603",
  celular: "3212191805", // guardado SIN el +57
  correo: "daniel@ejemplo.com",
});

const r1 = await consultarClienteConocidoTool.handler({}, { channel: "whatsapp", externalId: "+573212191805" });
const d1 = r1.result as any;
verificar("encontró al cliente", d1.encontrado === true, JSON.stringify(d1));
verificar("nombre exacto de la base (nunca inventado)", d1.nombre === "Daniel Pataquiva", `vino "${d1.nombre}"`);
verificar("documento exacto de la base", d1.numero_documento === "10009040603", `vino "${d1.numero_documento}"`);
verificar("el mensaje menciona el nombre", (r1.reply_to_user ?? "").includes("Daniel Pataquiva"), r1.reply_to_user ?? "");
verificar("el mensaje menciona el documento", (r1.reply_to_user ?? "").includes("10009040603"), r1.reply_to_user ?? "");
verificar(
  "NO le dice 'compárteme tus datos' (el bug que reportó Daniel)",
  !/comparte|dame tus datos|compártame/i.test(r1.reply_to_user ?? ""),
  r1.reply_to_user ?? ""
);

// --- CASO 2: cliente nuevo, ningún celular coincide --------------------------------------------
console.log("\n" + "─".repeat(92));
console.log("CASO 2. Celular sin historial: cliente nuevo, sigue el flujo de siempre");
console.log("─".repeat(92));
// (deja la fila del caso 1 en la base a propósito — otra conversación, otro celular)
const r2 = await consultarClienteConocidoTool.handler({}, { channel: "whatsapp", externalId: "+573000000099" });
const d2 = r2.result as any;
verificar("no encontró a nadie", d2.encontrado === false, JSON.stringify(d2));
verificar("le pide los datos como siempre", /compart|dame tus datos/i.test(r2.reply_to_user ?? ""), r2.reply_to_user ?? "");

// --- CASO 3: el celular de OTRA conversación nunca contamina esta ------------------------------
console.log("\n" + "─".repeat(92));
console.log("CASO 3. Nunca busca por lo que diga el cliente — solo por el celular real de la conversación");
console.log("─".repeat(92));
// El handler no recibe ningún argumento de "celular a buscar" — solo ctx.externalId. Confirmamos
// que aunque exista un cliente #501 en la base, una conversación de OTRO número no lo encuentra.
const r3 = await consultarClienteConocidoTool.handler({}, { channel: "whatsapp", externalId: "+573109999999" });
const d3 = r3.result as any;
verificar("un celular distinto no trae los datos de otro cliente", d3.encontrado === false, JSON.stringify(d3));

console.log("\n" + "█".repeat(92));
if (fallos === 0) console.log("  RESULTADO: ✅ todos los casos pasaron.");
else { console.log(`  RESULTADO: ❌ ${fallos} caso(s) fallaron.`); process.exitCode = 1; }
console.log("█".repeat(92) + "\n");
