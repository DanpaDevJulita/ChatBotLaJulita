/**
 * PRUEBA MANUAL — UNA SOLA RESERVA REAL en LobbyPMS, para responder una pregunta concreta:
 *
 *   `POST /bookings` (crearReservaLobby, en src/core/integrations/lobbypms.ts) manda `end_date`
 *   tal cual la fecha de SALIDA (checkout). Para `/available-rooms` y para `/block` ya se
 *   confirmó que `end_date` es INCLUSIVO (la última noche, no el día de salida) — pero para
 *   `/bookings` nunca se probó con una reserva real, así que es una suposición sin confirmar.
 *   Si LobbyPMS también lo trata como inclusivo ahí, esta prueba va a dejar bloqueadas DOS
 *   noches en el calendario en vez de una.
 *
 * ESTE SCRIPT NO SE PUEDE CORRER DESDE LA NUBE: la red de esta sesión (el sandbox donde vive
 * Claude) tiene bloqueado el host de LobbyPMS de entrada — así que esto solo sirve si Daniel lo
 * corre ACÁ, en su propio computador, con su .env real (LOBBYPMS_API_TOKEN adentro).
 *
 * Qué hace, en orden:
 *   1. Busca disponibilidad para una fecha MUY lejana (2028-09-20, dos años a futuro) en la
 *      categoría más chica (DOMO ROMANTIC / clásico, capacidad 2) — para no chocar con ninguna
 *      reserva real ni ocupar algo que un cliente pudiera necesitar.
 *   2. Si hay cupo, crea UNA reserva real de UNA noche (2028-09-20 -> 2028-09-21), con un nombre
 *      y nota que NO dejan lugar a dudas de que es de prueba, para que sea imposible confundirla
 *      con un cliente real en el panel.
 *   3. Imprime el `bookingId` que devolvió LobbyPMS y qué hay que mirar en el calendario.
 *
 * NO se crea ningún cliente en LobbyPMS (se usa el respaldo `holder_name`, no
 * `crearOActualizarClienteLobby`) — para no dejar un "cliente fantasma" además de la reserva.
 *
 * NO borra nada sola — no existe (todavía) una función para cancelar una reserva por API. Daniel
 * tiene que borrarla a mano desde el panel de LobbyPMS después de mirar el calendario. Por eso el
 * script imprime bien claro el bookingId y la fecha para encontrarla fácil.
 *
 * SEGURIDAD: como esto SÍ toca la LobbyPMS real (no hay nada simulado acá), no hace nada hasta
 * que se lo pidas con el env var CONFIRMO_RESERVA_REAL=si — así nunca se dispara sin querer.
 *
 * Cómo correrlo (en tu computador, con el .env real en la carpeta del proyecto):
 *   CONFIRMO_RESERVA_REAL=si npx tsx pruebas/prueba-reserva-real-lobby.ts
 */
import "dotenv/config";
import { consultarDisponibilidad, resolverCategoryId, crearReservaLobby } from "../src/core/integrations/lobbypms.js";

// Categoría de prueba: la más chica, para que si algo sale raro el impacto sea mínimo.
const CLASE: "chalet" | "clasico" | "deluxe" = "clasico";
const CAPACIDAD = 2; // DOMO ROMANTIC

// Fecha MUY lejana — 2 años a futuro. Ningún cliente real debería tener nada reservado ahí.
const FECHA_ENTRADA = "2028-09-20";
const FECHA_SALIDA = "2028-09-21"; // 1 noche, si `end_date` es exclusivo (lo que se está probando)

const NOMBRE_DE_PRUEBA = "PRUEBA BOT BORRAR";
const NOTA = "PRUEBA TÉCNICA DEL BOT — BORRAR. Creada el 2026-09-11 para confirmar si end_date de " +
  "POST /bookings es inclusivo o exclusivo. Ver pruebas/prueba-reserva-real-lobby.ts.";

async function main() {
  console.log("\n" + "█".repeat(92));
  console.log("  PRUEBA MANUAL — una reserva real en LobbyPMS (POST /bookings)");
  console.log("█".repeat(92));
  console.log(`\nFecha: ${FECHA_ENTRADA} -> ${FECHA_SALIDA} · Categoría: ${CLASE} (capacidad ${CAPACIDAD})\n`);

  if (process.env.CONFIRMO_RESERVA_REAL !== "si") {
    console.log(
      "No se creó nada. Esto SÍ toca la LobbyPMS real de producción, así que hace falta confirmarlo\n" +
        "a propósito. Para correrla de verdad:\n\n" +
        "  CONFIRMO_RESERVA_REAL=si npx tsx pruebas/prueba-reserva-real-lobby.ts\n"
    );
    return;
  }

  if (!process.env.LOBBYPMS_API_TOKEN) {
    console.error("Falta LOBBYPMS_API_TOKEN en tu .env — sin eso LobbyPMS no va a dejar hacer nada. Corta acá.");
    process.exitCode = 1;
    return;
  }

  console.log("1) Consultando disponibilidad real...");
  const disponibilidad = await consultarDisponibilidad(FECHA_ENTRADA, 1);
  if (!disponibilidad) {
    console.error(
      "No pude ni siquiera consultar la disponibilidad (ni la API oficial ni el motor público " +
        "respondieron). No se creó ninguna reserva. Revisá la conexión / el token y probá de nuevo."
    );
    process.exitCode = 1;
    return;
  }

  const paraLaClase = disponibilidad.find((d) => d.clase === CLASE && d.capacidad === CAPACIDAD);
  console.log(`   Disponibilidad para ${CLASE}/${CAPACIDAD}: ${paraLaClase?.disponibles ?? 0} unidad(es).`);
  if (!paraLaClase || paraLaClase.disponibles <= 0) {
    console.error("No hay disponibilidad para esa categoría en esa fecha. No se creó ninguna reserva.");
    process.exitCode = 1;
    return;
  }

  console.log("2) Resolviendo category_id real de LobbyPMS...");
  const categoryId = await resolverCategoryId(CLASE, CAPACIDAD, FECHA_ENTRADA, 1);
  if (!categoryId) {
    console.error("No pude resolver el category_id (raro, si la disponibilidad sí contestó). No se creó nada.");
    process.exitCode = 1;
    return;
  }
  console.log(`   category_id = ${categoryId}`);

  console.log("3) Creando la reserva real (POST /bookings)...");
  const reserva = await crearReservaLobby({
    categoryId,
    fechaEntradaISO: FECHA_ENTRADA,
    fechaSalidaISO: FECHA_SALIDA,
    totalAdultos: 1,
    nombreSiNuevo: NOMBRE_DE_PRUEBA, // respaldo: NO crea un cliente real en LobbyPMS
    nota: NOTA,
  });

  if (!reserva) {
    console.error(
      "LobbyPMS NO aceptó la reserva (revisá el log de arriba, [lobbypms] no se pudo crear la reserva real, " +
        "para ver el motivo exacto que dio la API). No quedó nada creado."
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n" + "█".repeat(92));
  console.log("  ✅ SE CREÓ LA RESERVA DE PRUEBA");
  console.log("█".repeat(92));
  console.log(`
  booking_id (idBooking): ${reserva.bookingId}
  room_id:                ${reserva.roomId ?? "(no vino)"}
  Categoría:               ${CLASE} / capacidad ${CAPACIDAD} (category_id ${categoryId})
  Se pidió:                ${FECHA_ENTRADA} -> ${FECHA_SALIDA} (pensado como 1 noche)
  Nombre en LobbyPMS:      "${NOMBRE_DE_PRUEBA}"

  AHORA, EN EL PANEL DE LOBBYPMS:
  1. Andá al calendario y buscá el ${FECHA_ENTRADA} en la categoría "DOMO ROMANTIC" (o la que
     corresponda a ${CLASE}/cap.${CAPACIDAD}).
  2. Mirá si la reserva "${NOMBRE_DE_PRUEBA}" ocupa SOLO el ${FECHA_ENTRADA}, o si también aparece
     ocupando el ${FECHA_SALIDA}:
       - Si ocupa SOLO el ${FECHA_ENTRADA}  -> end_date es EXCLUSIVO (como se asumió en el código:
         no hay que tocar nada en reservaLobby.ts).
       - Si ocupa TAMBIÉN el ${FECHA_SALIDA} -> end_date es INCLUSIVO en /bookings también, igual
         que en /available-rooms y /block — avisame ese resultado y ajusto reservaLobby.ts para
         que reste una noche antes de mandar end_date, si no todas las reservas reales quedarían
         bloqueando una noche de más.
  3. Borrá la reserva de prueba a mano desde el panel (no hay una función en el código para
     cancelarla por API todavía).
`);
}

main().catch((e) => {
  console.error("Error corriendo la prueba:", e);
  process.exitCode = 1;
});
