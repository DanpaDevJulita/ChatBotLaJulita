/**
 * PRUEBA: dos mensajes del mismo cliente NO se procesan al mismo tiempo.
 *
 * El caso real (2026-09-11): el cliente mandó nombre, cédula y celular en tres mensajes casi
 * simultáneos; el worker corría hasta 5 trabajos en paralelo sin orden por conversación, dos se
 * solaparon, y se crearon DOS reservas con DOS links de pago distintos por la misma estadía.
 *
 * Acá se prueba el candado (core/queue/enTurno.ts) con tareas que registran cuándo entran y
 * cuándo salen: si dos turnos de la misma conversación llegan a solaparse aunque sea un
 * instante, la prueba falla.
 */
import { enTurnoPorConversacion, conversacionesEnCurso } from "../src/core/queue/enTurno.js";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Marca { clave: string; evento: "entra" | "sale"; t: number }

/**
 * Corre varias tareas a la vez y mide DOS cosas distintas:
 *   - solapamientos por cliente: dos turnos del MISMO cliente corriendo a la vez. Tiene que ser
 *     siempre 0, es lo que causó las dos reservas duplicadas.
 *   - máximo en paralelo global: cuántas tareas llegaron a correr juntas. Entre clientes
 *     DISTINTOS tiene que ser > 1, porque si el candado frenara a todos el bot se haría lento.
 */
async function correrCaso(
  nombre: string,
  claves: string[],
  esperado: { sinSolaparPorCliente: boolean; enParaleloEntreClientes: boolean }
): Promise<boolean> {
  const marcas: Marca[] = [];
  const enCursoPorClave = new Map<string, number>();
  let enCursoGlobal = 0;
  let maxEnParalelo = 0;
  let solapamientosPorCliente = 0;

  await Promise.all(
    claves.map((clave, i) =>
      enTurnoPorConversacion(clave, async () => {
        marcas.push({ clave, evento: "entra", t: Date.now() });
        enCursoPorClave.set(clave, (enCursoPorClave.get(clave) ?? 0) + 1);
        if ((enCursoPorClave.get(clave) ?? 0) > 1) solapamientosPorCliente++;
        enCursoGlobal++;
        maxEnParalelo = Math.max(maxEnParalelo, enCursoGlobal);
        await dormir(40 + (i % 3) * 10); // el turno "tarda"
        enCursoGlobal--;
        enCursoPorClave.set(clave, (enCursoPorClave.get(clave) ?? 0) - 1);
        marcas.push({ clave, evento: "sale", t: Date.now() });
      })
    )
  );

  const etiquetas = new Map<string, string>();
  for (const c of claves) if (!etiquetas.has(c)) etiquetas.set(c, String.fromCharCode(65 + etiquetas.size));

  let ok = true;
  const detalle: string[] = [];
  if (esperado.sinSolaparPorCliente) {
    const bien = solapamientosPorCliente === 0;
    ok &&= bien;
    detalle.push(`${bien ? "✅" : "❌"} ningún cliente tuvo dos turnos a la vez (solapamientos: ${solapamientosPorCliente})`);
  }
  if (esperado.enParaleloEntreClientes) {
    const bien = maxEnParalelo > 1;
    ok &&= bien;
    detalle.push(`${bien ? "✅" : "❌"} clientes distintos siguen corriendo en paralelo (máximo a la vez: ${maxEnParalelo})`);
  }

  console.log(`\n  ${nombre}`);
  console.log(`    tareas: ${claves.length} · clientes distintos: ${new Set(claves).size}`);
  console.log(`    orden real: ${marcas.map((m) => `${etiquetas.get(m.clave)}${m.evento === "entra" ? "▶" : "◼"}`).join(" ")}`);
  for (const d of detalle) console.log(`    ${d}`);
  return ok;
}

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA — un turno por conversación a la vez (candado de core/queue/enTurno.ts)");
  console.log("█".repeat(92));

  const resultados: boolean[] = [];

  // 1. El caso que falló en producción: 3 mensajes seguidos del MISMO cliente.
  resultados.push(await correrCaso(
    "Mismo cliente, 3 mensajes casi simultáneos (nombre / cédula / celular)",
    ["whatsapp:+573212191805", "whatsapp:+573212191805", "whatsapp:+573212191805"],
    { sinSolaparPorCliente: true, enParaleloEntreClientes: false }
  ));

  // 2. Clientes distintos: tienen que seguir corriendo en paralelo (si no, el bot se hace lento).
  resultados.push(await correrCaso(
    "Tres clientes DISTINTOS al mismo tiempo",
    ["whatsapp:+57300000001", "whatsapp:+57300000002", "whatsapp:+57300000003"],
    { sinSolaparPorCliente: true, enParaleloEntreClientes: true }
  ));

  // 3. Mezcla: dos del mismo cliente + otros dos clientes.
  resultados.push(await correrCaso(
    "Mezcla: dos mensajes de un cliente y uno de cada uno de otros dos",
    ["whatsapp:+573212191805", "whatsapp:+573212191805", "whatsapp:+57300000004", "whatsapp:+57300000007"],
    { sinSolaparPorCliente: true, enParaleloEntreClientes: true }
  ));

  // 4. Si un turno explota, el siguiente del mismo cliente igual se tiene que atender.
  let siguienteCorrio = false;
  const claveFalla = "whatsapp:+57399999999";
  const queFalla = enTurnoPorConversacion(claveFalla, async () => {
    throw new Error("el turno explotó");
  });
  const queSigue = enTurnoPorConversacion(claveFalla, async () => {
    siguienteCorrio = true;
  });
  let propagoElError = false;
  await queFalla.catch(() => { propagoElError = true; });
  await queSigue;
  const okFalla = siguienteCorrio && propagoElError;
  console.log("\n  Un turno falla: el siguiente del mismo cliente NO se puede quedar sin atender");
  console.log(`    el error se le propagó a BullMQ (para que reintente): ${propagoElError ? "sí" : "NO"}`);
  console.log(`    el mensaje siguiente igual se procesó: ${siguienteCorrio ? "sí" : "NO"}`);
  console.log(`    ${okFalla ? "✅" : "❌"}`);
  resultados.push(okFalla);

  // 5. No se acumulan claves en memoria con el tiempo.
  await dormir(20);
  const quedaron = conversacionesEnCurso();
  const okMemoria = quedaron === 0;
  console.log("\n  Después de terminar todo, no quedan conversaciones colgadas en memoria");
  console.log(`    claves vivas: ${quedaron}`);
  console.log(`    ${okMemoria ? "✅" : "❌"}`);
  resultados.push(okMemoria);

  const fallos = resultados.filter((r) => !r).length;
  console.log("\n" + "█".repeat(92));
  if (fallos === 0) console.log(`  RESULTADO: ✅ ${resultados.length}/${resultados.length} casos pasaron.`);
  else { console.log(`  RESULTADO: ❌ ${fallos} de ${resultados.length} casos fallaron.`); process.exitCode = 1; }
  console.log("█".repeat(92) + "\n");
}

main().catch((e) => { console.error("Error corriendo la prueba:", e); process.exitCode = 1; });
