/**
 * Prueba el webhook de Bold SIN pagar nada y SIN depender de Bold.
 *
 * Arma el mismo evento que manda Bold cuando una venta queda aprobada (`SALE_APPROVED`), lo
 * firma igual que lo firma Bold (HMAC-SHA256 sobre el body en Base64, en el header
 * `x-bold-signature`) y se lo manda al bot, al endpoint POST /webhooks/bold.
 *
 *   npx tsx scripts/probar-webhook-bold.ts                       -> SIMULACRO: no manda nada
 *   npx tsx scripts/probar-webhook-bold.ts --enviar              -> manda el webhook de verdad
 *   npx tsx scripts/probar-webhook-bold.ts --referencia=res12-abono-1757 --enviar
 *   npx tsx scripts/probar-webhook-bold.ts --valor=50000 --enviar
 *   npx tsx scripts/probar-webhook-bold.ts --llave=api_key --enviar
 *   npx tsx scripts/probar-webhook-bold.ts --url=https://mi-tunel.trycloudflare.com/webhooks/bold --enviar
 *
 * SIN --enviar no toca nada: solo muestra qué pago usaría, cómo queda el evento y con qué llave
 * se firma. Sirve para revisar antes de disparar.
 *
 * CON --enviar SÍ ESCRIBE EN LA BASE DE VERDAD: el webhook marca ese pago como aprobado y
 * confirma la reserva, exactamente igual que si el cliente hubiera pagado. Úsalo solo con una
 * reserva de PRUEBA — el bot no tiene forma de "des-aprobar" un pago.
 *
 * Qué prueba exactamente:
 *   1. Que la firma que calcula el bot coincide con la que calcularía Bold (si la llave está mal
 *      configurada, la respuesta es 401 y ahí se ve).
 *   2. Que el bot encuentra la fila de `pagos` por la referencia.
 *   3. Que `fn_registrar_pago_aprobado` actualiza bien `pagos` y `reservas`.
 *
 * Lo ÚNICO que no prueba es que Bold de verdad mande los campos donde los esperamos
 * (`data.metadata.reference`, `data.payment_id`, `data.amount.total`). Eso solo lo confirma un
 * pago real — por eso el handler deja el payload completo en los logs si algo no cuadra.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function arg(nombre: string): string | null {
  const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.slice(nombre.length + 3) : null;
}
const tiene = (nombre: string) => process.argv.includes(`--${nombre}`);

const URL_WEBHOOK = arg("url") ?? "http://localhost:3000/webhooks/bold";
const ENVIAR = tiene("enviar");

/** Las mismas candidatas que prueba el bot, en el mismo orden (ver boldClient.ts). */
const LLAVES: Record<string, string> = {
  webhook_secret: process.env.BOLD_WEBHOOK_SECRET ?? "",
  api_key: process.env.BOLD_API_KEY ?? "",
  secret_key: process.env.BOLD_SECRET_KEY ?? "",
  vacia: "",
};

function elegirLlave(): { nombre: string; valor: string } {
  const pedida = arg("llave");
  if (pedida) {
    if (!(pedida in LLAVES)) {
      console.error(`Llave desconocida: ${pedida}. Usa una de: ${Object.keys(LLAVES).join(", ")}`);
      process.exit(1);
    }
    return { nombre: pedida, valor: LLAVES[pedida] };
  }
  // Auto: la primera que esté configurada, igual que el orden del bot.
  for (const nombre of ["webhook_secret", "api_key", "secret_key"]) {
    if (LLAVES[nombre]) return { nombre, valor: LLAVES[nombre] };
  }
  return { nombre: "vacia", valor: "" };
}

interface FilaPago {
  id: number;
  reserva_id: number;
  tipo: string;
  valor: number;
  estado: string;
  referencia: string | null;
  link_url: string | null;
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el .env");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

  console.log("=".repeat(78));
  console.log("PRUEBA DEL WEBHOOK DE BOLD");
  console.log("=".repeat(78));
  console.log(`Modo:     ${ENVIAR ? "⚠️  ENVIAR DE VERDAD (escribe en la base)" : "simulacro (no manda nada)"}`);
  console.log(`Endpoint: ${URL_WEBHOOK}`);

  // --- 1. Qué pago vamos a "aprobar" -------------------------------------------------------
  const referenciaPedida = arg("referencia");
  let pago: FilaPago | null = null;

  if (referenciaPedida) {
    const { data, error } = await supabase
      .from("pagos")
      .select("id, reserva_id, tipo, valor, estado, referencia, link_url")
      .eq("referencia", referenciaPedida)
      .maybeSingle();
    if (error) {
      console.error("No pude leer ese pago:", error.message);
      process.exit(1);
    }
    pago = data as FilaPago | null;
    if (!pago) {
      console.error(`\n❌ No existe ningún pago con referencia "${referenciaPedida}".`);
      process.exit(1);
    }
  } else {
    const { data, error } = await supabase
      .from("pagos")
      .select("id, reserva_id, tipo, valor, estado, referencia, link_url")
      .eq("estado", "pendiente")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("No pude leer la tabla de pagos:", error.message);
      process.exit(1);
    }
    pago = data as FilaPago | null;
    if (!pago) {
      console.error(
        "\n❌ No hay ningún pago pendiente en la base.\n" +
          "   Genera uno primero: escríbele al bot por WhatsApp hasta que te mande el link de pago,\n" +
          "   y vuelve a correr este script."
      );
      process.exit(1);
    }
  }

  if (!pago.referencia) {
    console.error(`\n❌ El pago #${pago.id} no tiene referencia guardada — sin eso Bold no lo podría identificar.`);
    process.exit(1);
  }

  const valor = Number(arg("valor") ?? pago.valor);
  const llave = elegirLlave();

  console.log("\n--- Pago que se va a aprobar -------------------------------------------------");
  console.log(`  pago #${pago.id}  (reserva #${pago.reserva_id})`);
  console.log(`  tipo:       ${pago.tipo}`);
  console.log(`  estado:     ${pago.estado}`);
  console.log(`  referencia: ${pago.referencia}`);
  console.log(`  valor en la fila: ${pago.valor}`);
  console.log(`  valor a "pagar":  ${valor}${arg("valor") ? "  (forzado con --valor)" : ""}`);
  if (pago.estado === "aprobado") {
    console.log("\n  ℹ️  Este pago YA está aprobado. El webhook debería responder sin volver a sumarlo");
    console.log("     (esa es justamente la prueba de idempotencia: Bold reintenta y no duplica).");
  }

  // --- 2. Cómo está la reserva ANTES --------------------------------------------------------
  const foto = async () => {
    const { data } = await supabase
      .from("reservas")
      .select("id, total, anticipo, saldo, estado_pago, estado_id, confirmed_at, expira_at")
      .eq("id", pago!.reserva_id)
      .maybeSingle();
    const { data: p } = await supabase
      .from("pagos")
      .select("estado, valor, bold_payment_id, fecha_pago, saldo_despues")
      .eq("id", pago!.id)
      .maybeSingle();
    return { reserva: data, pago: p };
  };

  const antes = await foto();
  console.log("\n--- ANTES --------------------------------------------------------------------");
  console.log("  pago:    ", JSON.stringify(antes.pago));
  console.log("  reserva: ", JSON.stringify(antes.reserva));

  // --- 3. El evento, igual que lo manda Bold ------------------------------------------------
  const boldPaymentId = `PRUEBA-${Date.now()}`;
  const evento = {
    id: `evt-prueba-${Date.now()}`,
    type: "SALE_APPROVED",
    subject: boldPaymentId,
    source: "prueba-local",
    // Bold manda el tiempo en nanosegundos.
    time: Date.now() * 1_000_000,
    data: {
      payment_id: boldPaymentId,
      merchant_id: "PRUEBA",
      created_at: new Date().toISOString(),
      amount: { total: valor, currency: "COP", taxes: [], tip: 0 },
      payment_method: "PRUEBA",
      metadata: { reference: pago.referencia },
    },
  };

  const body = JSON.stringify(evento);
  // Igual que Bold (y que verificarFirmaBold en boldClient.ts): primero Base64 del body, y sobre
  // ESE texto el HMAC-SHA256.
  const firma = crypto
    .createHmac("sha256", llave.valor)
    .update(Buffer.from(body, "utf8").toString("base64"))
    .digest("hex");

  console.log("\n--- Evento que se manda ------------------------------------------------------");
  console.log(`  firmado con la llave: ${llave.nombre}${llave.valor ? "" : "  (vacía — así firma Bold en sandbox)"}`);
  console.log(`  x-bold-signature: ${firma}`);
  console.log(`  body: ${body}`);

  if (!ENVIAR) {
    console.log("\n" + "=".repeat(78));
    console.log("SIMULACRO: no se mandó nada y no se tocó la base.");
    console.log("Si todo lo de arriba se ve bien, corre otra vez agregando --enviar");
    console.log("=".repeat(78));
    return;
  }

  // --- 4. Mandarlo --------------------------------------------------------------------------
  console.log("\n--- Respuesta del bot --------------------------------------------------------");
  let respuesta: Response;
  try {
    respuesta = await fetch(URL_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bold-signature": firma },
      body,
    });
  } catch (err) {
    console.error(`  ❌ No pude conectarme a ${URL_WEBHOOK}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    console.error("     ¿Está corriendo `npm run web`?");
    process.exit(1);
  }

  const texto = await respuesta.text();
  console.log(`  HTTP ${respuesta.status} — ${texto}`);

  if (respuesta.status === 401) {
    console.log("\n  ❌ Firma rechazada. El bot no reconoce la llave con la que firmamos.");
    console.log("     Prueba con otra: --llave=webhook_secret | api_key | secret_key | vacia");
    console.log("     (y revisa que el .env del bot tenga esa misma llave configurada).");
    return;
  }

  // --- 5. Cómo quedó DESPUÉS ----------------------------------------------------------------
  const despues = await foto();
  console.log("\n--- DESPUÉS ------------------------------------------------------------------");
  console.log("  pago:    ", JSON.stringify(despues.pago));
  console.log("  reserva: ", JSON.stringify(despues.reserva));

  const cambioPago = JSON.stringify(antes.pago) !== JSON.stringify(despues.pago);
  const cambioReserva = JSON.stringify(antes.reserva) !== JSON.stringify(despues.reserva);

  console.log("\n" + "=".repeat(78));
  if (cambioPago || cambioReserva) {
    console.log("✅ La base cambió: el webhook hizo su trabajo.");
    console.log("   Revisa arriba que `pago.estado` quedó en 'aprobado' y que la reserva");
    console.log("   tiene el anticipo/saldo y el estado que esperabas.");
  } else if (respuesta.status === 200) {
    console.log("ℹ️  El bot respondió 200 pero la base no cambió.");
    console.log("   Si el pago ya estaba aprobado, es lo correcto (idempotencia).");
    console.log("   Si no, mira la consola de `npm run web`: ahí queda el motivo exacto.");
  } else {
    console.log("❌ Algo falló. Mira la consola de `npm run web` para el detalle.");
  }
  console.log("=".repeat(78));
}

main().catch((err) => {
  console.error("Error inesperado:", err);
  process.exit(1);
});
