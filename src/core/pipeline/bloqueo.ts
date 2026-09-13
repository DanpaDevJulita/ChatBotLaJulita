import type { ChannelAdapter } from "../../channels/types.js";
import { liberarBloqueoSiVencido } from "../db/bloqueosRepo.js";
import { ultimaReservaDeCelular } from "../db/pagosRepo.js";
import { verificarPagoEnBold } from "./verificarPagoEnBold.js";
import { avisarPagoConfirmado } from "./avisarPago.js";
import { asegurarCupoConReintentos } from "./asegurarCupo.js";
import { notificarEscalamiento } from "./notificarEquipo.js";
import { insertMensaje } from "../db/mensajesRepo.js";
import { enviarSeguro } from "./enviar.js";
import { registrarMensajeDelBot } from "./runTurn.js";
import type { BloqueoJob } from "../queue/bloqueoQueue.js";
import { liberarBlockLobby } from "../integrations/lobbypms.js";

const MENSAJE_LIBERACION =
  "⏰ Ya pasaron los 10 minutos y no me llegó la confirmación del pago, así que liberé el cupo " +
  "que te había apartado — si alguien más lo tomó mientras tanto, puede que ya no esté 😕\n\n" +
  "Si seguís interesado, decime y reviso de nuevo la disponibilidad para esa fecha.";

/**
 * Se dispara BLOQUEO_MINUTOS después de crear un bloqueo (ver src/agentes/ventas/herramientas/reserva.ts).
 * Antes de avisar nada, vuelve a mirar el estado real en la base: si el equipo ya lo confirmó
 * con /confirmar (o si por lo que sea ya se liberó antes), `liberarBloqueoSiVencido` no toca
 * nada y devuelve null — así nunca se manda un aviso de "se venció" sobre algo que sí se pagó.
 */
export async function ejecutarLiberacionBloqueo(job: BloqueoJob, adapter: ChannelAdapter): Promise<void> {
  const key = `${job.canal}:${job.externalId}`;

  // [2026-09-11] ANTES de soltar el cupo, se le pregunta a Bold por lo bajo si el pago ya entró.
  //
  // Por qué: hasta ahora, si el cliente pagaba pero el webhook no llegaba (Bold admite demoras, y
  // si las llaves de integración no están habilitadas no avisa nunca) y el cliente no escribía
  // nada, pasaban las dos peores cosas juntas: se le liberaba un cupo YA PAGADO, y encima se le
  // escribía "liberé el cupo que te había apartado". Un cliente que acaba de pagar leyendo eso es
  // una queja segura y un cupo perdido.
  //
  // El cliente no se entera de esta consulta: si no hay pago, el flujo sigue exactamente igual
  // que antes. Si SÍ lo hay, no se libera nada y se le manda la confirmación que le correspondía.
  const reservaId = await ultimaReservaDeCelular(job.externalId);
  if (reservaId) {
    try {
      const verificacion = await verificarPagoEnBold(reservaId);
      if (verificacion.pagado) {
        console.log(
          `[bloqueo] ${key}: el pago de la reserva #${reservaId} SÍ estaba hecho ` +
            `(${verificacion.yaEstabaRegistrado ? "ya registrado" : "lo acabo de registrar"}) — ` +
            `NO libero el cupo #${job.bloqueoId}.`
        );

        // [2026-09-11] Pagó, sí — pero el dinero NO es lo mismo que el cupo. Como el pago entró
        // pasado el tiempo, la fecha pudo haberse soltado y hasta habérsela llevado otro cliente.
        // Antes de escribirle NADA que suene a confirmación, se comprueba (y si se puede, se
        // vuelve a tomar) el cupo en LobbyPMS. Regla del equipo: no se confirma hasta tenerlo en
        // las dos partes, nuestra base Y LobbyPMS.
        //
        // [2026-09-11] "No quiero que me escale nada, de ser muy necesario": si LobbyPMS no
        // contestó (posible tropiezo pasajero), se reintenta varias veces por dentro ANTES de
        // pensar en escalar — ver asegurarCupoConReintentos. Solo se escala cuando de verdad no
        // queda otra: o LobbyPMS confirmó que no hay disponibilidad, o se agotaron los reintentos
        // sin poder saberlo con certeza.
        const cupo = await asegurarCupoConReintentos(job.bloqueoId);
        const asegurado = cupo.estado === "asegurado";

        console.log(
          `[bloqueo] ${key}: estado del cupo tras el pago tardío -> ${cupo.estado} (${cupo.intentos ?? 1} intento(s))` +
            `${cupo.reactivado ? " (se volvió a tomar en LobbyPMS)" : ""}${cupo.motivo ? ` — ${cupo.motivo}` : ""}`
        );

        if (!verificacion.yaEstabaRegistrado) {
          await avisarPagoConfirmado({
            reservaId,
            totalPagado: verificacion.montoPagado,
            saldoPendiente: verificacion.saldoPendiente,
            estadoPago: verificacion.estadoPago,
            cupoAsegurado: asegurado,
          });
        }

        // Si el cupo NO quedó asegurado, esto deja de ser algo que el bot pueda resolver solo:
        // hay plata recibida y una fecha que puede no existir. Ya se reintentó por dentro
        // (asegurarCupoConReintentos) — esto es de verdad el último recurso. Va derecho al equipo.
        if (!asegurado) {
          console.error(
            `[bloqueo] ${key}: ⚠️ PAGO RECIBIDO SIN CUPO ASEGURADO tras ${cupo.intentos ?? 1} intento(s) — ` +
              `reserva #${reservaId}, bloqueo #${job.bloqueoId}, estado ${cupo.estado}: ${cupo.motivo ?? "sin detalle"}`
          );
          const razon =
            cupo.estado === "sin_cupo"
              ? `LobbyPMS confirmó que ya no hay disponibilidad (${cupo.motivo ?? "sin detalle"}).`
              : `no se pudo verificar la disponibilidad en LobbyPMS pese a ${cupo.intentos ?? 1} intento(s) ` +
                `(${cupo.motivo ?? "sin detalle"}).`;
          await notificarEscalamiento({
            canalCliente: job.canal,
            externalIdCliente: job.externalId,
            motivo:
              `PAGO RECIBIDO PERO EL CUPO NO ESTÁ ASEGURADO (reserva #${reservaId}): ${razon} ` +
              "El cliente pagó después del tiempo del bloqueo. Hay que confirmar la fecha a mano en LobbyPMS, " +
              "o proponerle otra fecha / devolverle el dinero.",
            mensajeCliente: "(aviso automático del bot, el cliente no escribió nada)",
          }).catch((err) => console.error(`[bloqueo] ${key}: además, falló el aviso al equipo:`, err));
        }
        return;
      }
    } catch (err) {
      // Que falle la consulta NO puede impedir que el cupo se libere: si no, un Bold caído
      // dejaría cupos bloqueados para siempre. Se loguea y se sigue con el flujo normal.
      console.error(`[bloqueo] ${key}: falló la consulta del pago a Bold, sigo con la liberación:`, err);
    }
  }

  const liberado = await liberarBloqueoSiVencido(job.bloqueoId);
  if (!liberado) {
    console.log(`[bloqueo] ${key}: bloqueo #${job.bloqueoId} ya no estaba pendiente (confirmado o ya liberado) — no aviso nada.`);
    return;
  }

  // [2026-09-10] Si este bloqueo también tenía un bloqueo REAL en LobbyPMS (POST /block, ver
  // registrar_datos_reserva), hay que liberarlo ahí también — si no, el cupo queda "tomado" en
  // el calendario de LobbyPMS aunque el bot ya lo liberó por dentro. Mejor esfuerzo: si falla,
  // el bloqueo real igual se vence solo cuando pasen los minutos que se le pidieron a LobbyPMS.
  if (liberado.lobby_block_id) {
    const ok = await liberarBlockLobby(liberado.lobby_block_id);
    if (!ok) {
      console.warn(
        `[bloqueo] ${key}: no pude liberar el bloqueo real de LobbyPMS (block_id=${liberado.lobby_block_id}) — ` +
          "se vencerá solo cuando pasen los minutos que se le pidieron a LobbyPMS."
      );
    }
  }

  const entregado = await enviarSeguro(adapter, job.externalId, MENSAJE_LIBERACION, key);
  if (!entregado) return;

  await insertMensaje({
    canal: job.canal,
    external_id: job.externalId,
    role: "assistant",
    content: MENSAJE_LIBERACION,
    agent_name: "bloqueo-liberado",
  });
  registrarMensajeDelBot(job.canal, job.externalId, MENSAJE_LIBERACION);

  console.log(`[bloqueo] ${key}: bloqueo #${job.bloqueoId} liberado por tiempo, cliente avisado.`);
}
