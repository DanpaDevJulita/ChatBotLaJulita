import fs from "node:fs";
import path from "node:path";
import type { ChannelAdapter } from "../../channels/types.js";
import { openrouter, LLM_MODEL } from "../llm/openrouter.js";
import { listMensajes, insertMensaje } from "../db/mensajesRepo.js";
import { getEstado } from "../db/estadoRepo.js";
import { enviarSeguro } from "./enviar.js";
import { registrarMensajeDelBot } from "./runTurn.js";
import { programarRecontacto, MAX_PASOS, type RecontactoJob } from "../queue/recontactoQueue.js";

const PROMPT_RECONTACTO = fs.readFileSync(path.join(process.cwd(), "prompts", "recontacto.md"), "utf-8");

/** Cuántos mensajes de la charla se le pasan al modelo para que retome con contexto. */
const MENSAJES_DE_CONTEXTO = 8;

/**
 * Manda UN recontacto de la cadena (paso 1, 2 o 3) y programa el siguiente.
 *
 * Portado de agente-ycloud-main/src/worker/followupWorker.ts, simplificado: allá la cadena se
 * apoyaba en una tabla `followups` propia; acá el jobId de BullMQ es único por conversación
 * (un solo recontacto pendiente por cliente) y las verificaciones se hacen al momento de
 * disparar, así no hace falta ninguna tabla nueva.
 *
 * Antes de escribirle al cliente verifica dos cosas, porque entre que se programó y se disparó
 * pudo pasar cualquier cosa:
 *   1. que el cliente no haya contestado después del mensaje que ancló este recontacto;
 *   2. que la conversación no esté escalada a un humano del equipo.
 */
export async function ejecutarRecontacto(job: RecontactoJob, adapter: ChannelAdapter): Promise<void> {
  const key = `${job.canal}:${job.externalId}`;
  const historial = await listMensajes(job.canal, job.externalId, 20);

  const anclaMs = Date.parse(job.ancla);
  const contestoDespues = historial.some(
    (m) => m.role === "user" && m.created_at != null && Date.parse(m.created_at) > anclaMs
  );
  if (contestoDespues) {
    console.log(`[recontacto] ${key}: el cliente ya contestó, no mando el paso ${job.paso}.`);
    return;
  }

  const estado = await getEstado(job.canal, job.externalId);
  if (estado.last_agent === "humano") {
    console.log(`[recontacto] ${key}: la conversación está con el equipo, no mando el paso ${job.paso}.`);
    return;
  }

  const esUltimo = job.paso >= MAX_PASOS;
  const transcripcion = historial
    .slice(-MENSAJES_DE_CONTEXTO)
    .map((m) => `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`)
    .join("\n");

  let texto = "";
  try {
    const completion = await openrouter.chat.completions.create({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: PROMPT_RECONTACTO },
        {
          role: "system",
          content: esUltimo
            ? "Este es el ÚLTIMO recontacto de la cadena: puedes darle un toque más de urgencia, sin inventar fechas límite y sin presionar feo."
            : "Este es un recontacto intermedio: liviano y casual, sin presión.",
        },
        {
          role: "user",
          content: transcripcion || "No hay contexto previo: saluda con calidez y ofrece ayuda con los planes.",
        },
      ] as any,
      temperature: 0.6,
    });
    texto = (completion.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    console.error(`[recontacto] ${key}: falló la generación del paso ${job.paso}:`, err);
    return; // sin texto preferimos quedarnos callados antes que mandar algo roto
  }

  if (!texto) {
    console.warn(`[recontacto] ${key}: el modelo devolvió texto vacío, no mando nada.`);
    return;
  }

  const entregado = await enviarSeguro(adapter, job.externalId, texto, key);
  if (!entregado) return;

  await insertMensaje({
    canal: job.canal,
    external_id: job.externalId,
    role: "assistant",
    content: texto,
    agent_name: `recontacto-${job.paso}`,
  });
  // Que el recontacto quede también en el historial en memoria: si el cliente contesta, el
  // agente ve lo que acabó de escribirle y no se repite.
  registrarMensajeDelBot(job.canal, job.externalId, texto);

  console.log(`[recontacto] ${key}: mandado el paso ${job.paso}/${MAX_PASOS}.`);

  if (!esUltimo) {
    await programarRecontacto(job.canal, job.externalId, job.paso + 1, new Date().toISOString());
  }
}
