import type { ChannelAdapter } from "../../channels/types.js";
import { liberarBloqueoSiVencido } from "../db/bloqueosRepo.js";
import { insertMensaje } from "../db/mensajesRepo.js";
import { enviarSeguro } from "./enviar.js";
import { registrarMensajeDelBot } from "./runTurn.js";
import type { BloqueoJob } from "../queue/bloqueoQueue.js";

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
  const liberado = await liberarBloqueoSiVencido(job.bloqueoId);
  if (!liberado) {
    console.log(`[bloqueo] ${key}: bloqueo #${job.bloqueoId} ya no estaba pendiente (confirmado o ya liberado) — no aviso nada.`);
    return;
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
