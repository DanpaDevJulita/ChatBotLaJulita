/**
 * PRUEBA: los recargos de niños y mascotas salen de la BASE, no del texto libre de un plan.
 *
 * [2026-09-14] Pedido de Daniel: "para el tema de niños y mascotas adicionales sí se debe crear la
 * tabla donde se pongan con su respectivo valor, para que cuando el plan salga eso el bot tome de
 * las tablas los precios".
 *
 * El problema que resuelve: esos valores estaban escritos a mano dentro de la descripción de
 * algunos planes (">3 años $50.000"). Como no existían en ninguna columna, el bot no los podía
 * verificar y los BORRABA antes de mandar el mensaje — el cliente se enteraba del recargo por su
 * hijo cuando llegaba al glamping.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.FOLLOWUP_ENABLED ||= "false";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const { consultarRecargosTool } = await import("../src/agentes/ventas/herramientas/recargos.js");

const CTX = { channel: "whatsapp", externalId: "+573000000000" };
let fallas = 0;

function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

console.log("CASO 1. Sin nada cargado: dice que lo confirma con el equipo (acá SÍ corresponde)\n");
{
  const r = await consultarRecargosTool.handler({ tipo: "mascota" }, CTX);
  const texto = r.reply_to_user ?? "";
  revisar(
    /confirmar ese valor con el equipo/i.test(texto),
    "avisa que lo confirma con el equipo — el dato de verdad no existe todavía",
    `contestó otra cosa: "${texto.slice(0, 90)}"`
  );
  revisar(!/\$\s?\d/.test(texto), "no se inventó ninguna cifra", "¡se inventó un valor que no está en la base!");
}

// Ahora sí, los recargos cargados (como quedan con sql/recargos.sql).
filasDe("recargos").push(
  { id: 1, tipo: "nino", nombre: "Niño de 3 a 5 años", descripcion: "Valor por noche, adicional al plan.", precio: 50000, edad_min: 3, edad_max: 5, plan_id: null, activo: true },
  { id: 2, tipo: "nino", nombre: "Niño de 6 años en adelante", descripcion: "Valor por noche, adicional al plan.", precio: 70000, edad_min: 6, edad_max: null, plan_id: null, activo: true },
  { id: 3, tipo: "mascota", nombre: "Mascota pequeña (hasta 10 kg)", descripcion: "Valor por estadía. Máximo 1 por domo.", precio: 40000, edad_min: null, edad_max: null, plan_id: null, activo: true }
);

console.log("\nCASO 2. Con la edad del niño: contesta el valor exacto que le toca\n");
{
  const cuatro = await consultarRecargosTool.handler({ tipo: "nino", edad_del_nino: 4 }, CTX);
  const t4 = cuatro.reply_to_user ?? "";
  console.log(`  (4 años) ${t4}`);
  revisar(t4.includes("50.000"), "un niño de 4 años paga $50.000", `dijo otra cosa: "${t4}"`);

  const ocho = await consultarRecargosTool.handler({ tipo: "nino", edad_del_nino: 8 }, CTX);
  const t8 = ocho.reply_to_user ?? "";
  console.log(`  (8 años) ${t8}`);
  revisar(t8.includes("70.000"), "un niño de 8 años paga $70.000", `dijo otra cosa: "${t8}"`);

  const bebe = await consultarRecargosTool.handler({ tipo: "nino", edad_del_nino: 1 }, CTX);
  const t1 = bebe.reply_to_user ?? "";
  console.log(`  (1 año)  ${t1}`);
  revisar(/no paga recargo/i.test(t1), "un bebé de 1 año no paga recargo", `dijo otra cosa: "${t1}"`);
}

console.log("\nCASO 3. Sin edad: muestra la tabla completa, con sus rangos\n");
{
  const r = await consultarRecargosTool.handler({}, CTX);
  const texto = r.reply_to_user ?? "";
  console.log(texto.split("\n").map((l) => `  | ${l}`).join("\n"));
  revisar(texto.includes("50.000") && texto.includes("70.000"), "muestra los dos valores de niños", "faltan valores de niños");
  revisar(texto.includes("40.000"), "muestra el valor de la mascota", "falta el valor de mascota");
}

console.log("\nCASO 4. Un recargo desactivado no se le muestra al cliente\n");
{
  filasDe("recargos").push({
    id: 4, tipo: "mascota", nombre: "Mascota grande (PROMO VIEJA)", descripcion: null,
    precio: 999999, edad_min: null, edad_max: null, plan_id: null, activo: false,
  });
  const r = await consultarRecargosTool.handler({ tipo: "mascota" }, CTX);
  const texto = r.reply_to_user ?? "";
  revisar(!texto.includes("999.999"), "el recargo desactivado no aparece", "¡apareció un recargo que estaba desactivado!");
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ Los recargos de niños y mascotas salen de la base, y lo que no existe no se inventa.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
