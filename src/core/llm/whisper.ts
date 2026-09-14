import { openrouter } from "./openrouter.js";

/**
 * Transcripción de notas de voz de WhatsApp — mismo enfoque que
 * agente-ycloud-main/src/services/whisper.ts ("Sebas Raider"), portado acá: OpenRouter no
 * expone el endpoint /audio/transcriptions de Whisper, así que se usa un modelo multimodal
 * con soporte de audio (por defecto google/gemini-2.5-flash) vía chat.completions, mandando
 * el audio como content part `input_audio`.
 *
 * Reutiliza el mismo cliente `openrouter` (misma API key / baseURL) que ya arma el resto del
 * bot en core/llm/openrouter.ts, en vez de crear uno aparte solo para esto.
 */

const OPENROUTER_AUDIO_MODEL = process.env.OPENROUTER_AUDIO_MODEL ?? "google/gemini-2.5-flash";

function mimeAFormato(mime: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a")) return "m4a";
  if (m.includes("webm")) return "webm";
  if (m.includes("amr")) return "amr";
  if (m.includes("flac")) return "flac";
  return "ogg"; // WhatsApp manda notas de voz como audio/ogg (codec opus) casi siempre
}

/**
 * Transcribe una nota de voz a texto plano en español. Devuelve string vacío (nunca lanza por
 * un audio "raro") si el modelo no devuelve nada aprovechable; los errores de red/API sí se
 * propagan para que quien llama decida cómo avisarle al cliente.
 */
export async function transcribirAudio(buffer: Buffer, mime: string): Promise<string> {
  const format = mimeAFormato(mime);
  const base64 = buffer.toString("base64");

  const res = await openrouter.chat.completions.create({
    model: OPENROUTER_AUDIO_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Transcribí el siguiente audio al español. Devolvé ÚNICAMENTE la transcripción " +
              "en texto plano, sin comillas ni comentarios. Si el audio está vacío o es solo " +
              "ruido, devolvé un string vacío.",
          },
          {
            type: "input_audio",
            input_audio: { data: base64, format },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
      },
    ],
    temperature: 0,
    max_tokens: 800,
  });

  const texto = res.choices?.[0]?.message?.content?.toString() ?? "";
  return texto.trim();
}
