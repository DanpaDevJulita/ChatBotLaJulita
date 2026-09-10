/**
 * [2026-09-10] Prueba end-to-end de postventa y ventas contra el Supabase REAL.
 *
 * Por qué existe: ni el sandbox de nube de Claude ni el puente a este equipo (device_bash)
 * tienen salida de red hacia Supabase ni hacia LobbyPMS (ambos bloqueados por política de
 * red de esos entornos). La única red real que puede llegar a Supabase/LobbyPMS es la de
 * ESTA máquina corriendo el comando de verdad — por eso este script se corre acá, no desde
 * el lado de Claude.
 *
 * Qué SÍ toca la base de datos:
 *  - Lecturas (siempre): planes, adicionales, disponibilidad, buscar_reserva_cliente.
 *  - Escritura (solo si la pedís explícitamente): registrar_datos_reserva con datos de
 *    prueba bien marcados como "PRUEBA BOT BORRAR", y al final te da el comando SQL exacto
 *    para borrar lo que creó. Por defecto NO escribe nada.
 *
 * Uso:
 *   npx tsx scripts/probar-flujos-reales.ts
 *   npx tsx scripts/probar-flujos-reales.ts --celular=573001234567   (para probar postventa con un celular real que ya tenga reservas)
 *   npx tsx scripts/probar-flujos-reales.ts --escritura              (además prueba el registro real, con datos de prueba)
 */
import "dotenv/config";
import { herramientasDe } from "../src/agentes/_registro.js";

const args = process.argv.slice(2);
const celularReal = args.find((a) => a.startsWith("--celular="))?.split("=")[1];
const probarEscritura = args.includes("--escritura");

const ctx = { channel: "console" as const, externalId: "3009999999-prueba-bot" };

function titulo(t: string) {
  console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);
}

async function llamar(herramientas: any[], nombre: string, args: any, ctxUsado = ctx) {
  const h = herramientas.find((h) => h.name === nombre);
  if (!h) {
    console.log(`  [FALTA] no existe la herramienta "${nombre}"`);
    return null;
  }
  try {
    const r = await h.handler(args, ctxUsado);
    console.log(`  reply_to_user:\n    ${String(r.reply_to_user ?? "(sin texto)").split("\n").join("\n    ")}`);
    return r;
  } catch (e: any) {
    console.log(`  [ERROR] la herramienta lanzó una excepción (esto NO debería pasar nunca): ${e?.message ?? e}`);
    return null;
  }
}

async function main() {
  const postventa = await herramientasDe("postventa");
  const ventas = await herramientasDe("ventas");

  titulo("POSTVENTA — celular inventado (debe decir 0 reservas y ofrecer pivotar a ventas)");
  await llamar(postventa, "buscar_reserva_cliente", {}, { channel: "console", externalId: "0000000000-no-existe" });

  if (celularReal) {
    titulo(`POSTVENTA — celular real pasado por --celular=${celularReal}`);
    await llamar(postventa, "buscar_reserva_cliente", {}, { channel: "console", externalId: celularReal });
  } else {
    console.log(
      "\n(Salteado: pasá --celular=<numero real con reservas confirmadas> para probar el caso 1/varias reservas.)"
    );
  }

  titulo("VENTAS — consultar_planes sin filtros (menú)");
  await llamar(ventas, "consultar_planes", {});

  titulo("VENTAS — consultar_planes con fecha futura (toca LobbyPMS: sin IP autorizada, debe degradar sin romperse)");
  const fechaFutura = new Date(Date.now() + 45 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await llamar(ventas, "consultar_planes", { fecha: fechaFutura, nivel: "clasico" });

  titulo("VENTAS — consultar_adicionales");
  await llamar(ventas, "consultar_adicionales", {});

  titulo("VENTAS — consultar_fechas_alternativas (toca LobbyPMS: se espera el mensaje de 'consulto con el equipo')");
  await llamar(ventas, "consultar_fechas_alternativas", { fecha: fechaFutura, noches: 2 });

  titulo("VENTAS — registrar_datos_reserva CON DATOS INCOMPLETOS (no debe escribir nada en la base)");
  await llamar(ventas, "registrar_datos_reserva", { plan: "no existe este plan", fecha: fechaFutura });

  if (probarEscritura) {
    titulo("VENTAS — registrar_datos_reserva CON DATOS COMPLETOS DE PRUEBA (esto SÍ escribe en `clientes`/`acompanantes`)");
    const docPrueba = "9999999999"; // buscar y borrar por este número de documento
    const r = await llamar(ventas, "registrar_datos_reserva", {
      plan: "no existe este plan pero no importa: solo probamos la escritura del cliente",
      fecha: fechaFutura,
      personas: 1,
      cliente: {
        nombre: "ZZZ PRUEBA BOT BORRAR ZZZ",
        tipo_documento: "cédula",
        numero_documento: docPrueba,
        celular: "3009999999",
      },
    });
    console.log(
      `\n  Para borrar el registro de prueba, corré en el SQL editor de Supabase:\n` +
        `    delete from acompanantes where cliente_id in (select id from clientes where numero_documento = '${docPrueba}');\n` +
        `    delete from clientes where numero_documento = '${docPrueba}';\n`
    );
  } else {
    console.log(
      "\n(Salteado el registro real: pasá --escritura si querés probar la escritura de verdad en `clientes`. " +
        "Deja un registro de PRUEBA fácil de borrar, con el comando de limpieza incluido al final.)"
    );
  }

  titulo("LISTO");
}

main();
