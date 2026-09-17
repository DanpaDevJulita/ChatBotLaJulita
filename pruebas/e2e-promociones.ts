/**
 * PRUEBA: módulo de promociones (carousel de WhatsApp, ver REFERENCIA-MODULO-PROMOCIONES.md).
 *
 * Cubre lo que más importa de este módulo: que el envío se BLOQUEE con un mensaje claro antes
 * de gastar un solo mensaje si algo no calza (número de tarjetas distinto al aprobado, falta el
 * link del botón), y que con todo en orden sí arme y mande el carousel a cada destinatario.
 */
process.env.SUPABASE_URL ||= "https://prueba.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";
process.env.OPENROUTER_API_KEY ||= "prueba";
process.env.LOBBYPMS_API_TOKEN ||= "prueba";
process.env.YCLOUD_DRY_RUN = "true";
process.env.YCLOUD_FROM_PHONE_NUMBER ||= "+573000000000";

const { instalarSupabaseFalso, filasDe } = await import("./fakes.js");
instalarSupabaseFalso();

const { armarTarjetasPromociones, enviarPromocionesCarousel } = await import(
  "../src/core/marketing/promocionesBroadcast.js"
);

let fallas = 0;
function revisar(ok: boolean, bien: string, mal: string) {
  if (ok) console.log(`  ✅ ${bien}`);
  else {
    console.log(`  ❌ ${mal}`);
    fallas++;
  }
}

function sembrar(promos: any[], plantillas: any[]) {
  filasDe("promociones").length = 0;
  filasDe("promociones").push(...promos);
  filasDe("plantillas_carousel").length = 0;
  filasDe("plantillas_carousel").push(...plantillas);
  filasDe("promociones_envios").length = 0;
}

const PLANTILLA_3 = {
  id: 1,
  nombre_plantilla: "promos_lajulita_carousel_3",
  idioma: "es",
  cantidad_tarjetas: 3,
  incluye_boton_url: true,
  activa: true,
};

console.log("CASO 1. Menos promociones activas que tarjetas de la plantilla: se bloquea\n");
{
  sembrar(
    [
      { id: 1, nombre: "2x1 domo confort", texto_tarjeta: "🎉 2x1", imagen_url: "https://x/a.jpg", boton_url: "https://x/a", activa: true, orden: 0 },
    ],
    [PLANTILLA_3]
  );
  try {
    await armarTarjetasPromociones("promos_lajulita_carousel_3");
    revisar(false, "", "debía lanzar error por número de tarjetas distinto y no lo hizo");
  } catch (err: any) {
    revisar(
      /3 tarjeta/.test(err.message) && /1 promoci/.test(err.message),
      "el mensaje explica cuántas tarjetas pide la plantilla y cuántas promos hay activas",
      `mensaje inesperado: ${err.message}`
    );
  }
}

console.log("\nCASO 2. Falta el link del botón en una promoción, con plantilla que lo exige\n");
{
  sembrar(
    [
      { id: 1, nombre: "2x1 domo confort", texto_tarjeta: "🎉 2x1", imagen_url: "https://x/a.jpg", boton_url: "https://x/a", activa: true, orden: 0 },
      { id: 2, nombre: "Plan Paraíso -20%", texto_tarjeta: "💸 -20%", imagen_url: "https://x/b.jpg", boton_url: null, activa: true, orden: 1 },
      { id: 3, nombre: "Familiar sin costo extra", texto_tarjeta: "👨‍👩‍👧 Gratis niño", imagen_url: "https://x/c.jpg", boton_url: "https://x/c", activa: true, orden: 2 },
    ],
    [PLANTILLA_3]
  );
  try {
    await armarTarjetasPromociones("promos_lajulita_carousel_3");
    revisar(false, "", "debía lanzar error por falta de link y no lo hizo");
  } catch (err: any) {
    revisar(
      /Plan Paraíso -20%/.test(err.message),
      "el mensaje dice cuál promoción le falta el link del botón",
      `mensaje inesperado: ${err.message}`
    );
  }
}

console.log("\nCASO 3. Todo en orden: arma las 3 tarjetas y las manda (dry-run) a cada número\n");
{
  sembrar(
    [
      { id: 1, nombre: "2x1 domo confort", texto_tarjeta: "🎉 2x1", imagen_url: "https://x/a.jpg", boton_url: "https://x/a", activa: true, orden: 0 },
      { id: 2, nombre: "Plan Paraíso -20%", texto_tarjeta: "💸 -20%", imagen_url: "https://x/b.jpg", boton_url: "https://x/b", activa: true, orden: 1 },
      { id: 3, nombre: "Familiar sin costo extra", texto_tarjeta: "👨‍👩‍👧 Gratis niño", imagen_url: "https://x/c.jpg", boton_url: "https://x/c", activa: true, orden: 2 },
      // Esta está INACTIVA — no debe contar ni aparecer en las tarjetas armadas.
      { id: 4, nombre: "Promo vieja", texto_tarjeta: "vieja", imagen_url: "https://x/d.jpg", boton_url: "https://x/d", activa: false, orden: 3 },
    ],
    [PLANTILLA_3]
  );

  const armado = await armarTarjetasPromociones("promos_lajulita_carousel_3");
  revisar(armado.tarjetas.length === 3, "arma exactamente 3 tarjetas (ignora la inactiva)", `armó ${armado.tarjetas.length}`);

  const resultado = await enviarPromocionesCarousel("promos_lajulita_carousel_3", [
    "+573001110099",
    "+573002220088",
    "+573001110099", // repetido a propósito — no debe duplicarse.
  ]);
  revisar(resultado.resultados.length === 2, "quita destinatarios repetidos antes de enviar", `mandó a ${resultado.resultados.length}`);
  revisar(resultado.exitosos === 2 && resultado.fallidos === 0, "los dos envíos (dry-run) salen exitosos", `exitosos=${resultado.exitosos} fallidos=${resultado.fallidos}`);

  const envios = filasDe("promociones_envios");
  revisar(envios.length === 1, "deja registro de la campaña en promociones_envios", `hay ${envios.length} registro(s)`);
}

console.log("\nCASO 4. Número de destinatario mal escrito: se bloquea antes de mandar nada\n");
{
  sembrar(
    [{ id: 1, nombre: "2x1 domo confort", texto_tarjeta: "🎉 2x1", imagen_url: "https://x/a.jpg", boton_url: "https://x/a", activa: true, orden: 0 }],
    [{ ...PLANTILLA_3, cantidad_tarjetas: 1 }]
  );
  try {
    await enviarPromocionesCarousel("promos_lajulita_carousel_3", ["3001110099"]); // sin "+"
    revisar(false, "", "debía rechazar el número sin '+' y no lo hizo");
  } catch (err: any) {
    revisar(/3001110099/.test(err.message), "avisa cuál número está mal escrito", `mensaje inesperado: ${err.message}`);
  }
}

console.log("\n" + "█".repeat(96));
if (fallas === 0) {
  console.log("  RESULTADO: ✅ El módulo de promociones valida y envía el carousel como se espera.");
} else {
  console.log(`  RESULTADO: ❌ ${fallas} falla(s).`);
  process.exitCode = 1;
}
console.log("█".repeat(96));
