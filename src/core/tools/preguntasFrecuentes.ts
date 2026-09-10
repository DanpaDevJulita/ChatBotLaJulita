import type { ToolDefinition } from "./types.js";
import { listFaq } from "../db/faqRepo.js";

/**
 * Antes esto era un objeto hardcodeado con [PLACEHOLDER]s — ahora lee de la tabla `faq`
 * en Supabase, así que el equipo de La Julita puede editar las respuestas desde el panel
 * de administración sin tocar código ni reiniciar el servidor.
 */
export const preguntasFrecuentesTool: ToolDefinition = {
  name: "preguntas_frecuentes",
  description:
    "Responde preguntas frecuentes sobre el glamping La Julita: ubicación, cómo llegar, qué incluye la tarifa, mascotas, horarios, y cualquier otro tema que el equipo haya agregado en el panel de administración.",
  // Este `parameters` estático es el respaldo si Supabase no responde a tiempo al armar
  // el schema — getParameters (abajo) lo reemplaza con la lista real de temas cuando puede.
  parameters: {
    type: "object",
    properties: {
      tema: { type: "string", description: "El tema exacto sobre el que pregunta el cliente." },
    },
    required: ["tema"],
  },
  getParameters: async () => {
    const todas = await listFaq();
    const temas = todas.map((f) => f.tema);
    return {
      type: "object",
      properties: {
        tema: {
          type: "string",
          ...(temas.length > 0 ? { enum: temas } : {}),
          description: "El tema exacto sobre el que pregunta el cliente.",
        },
      },
      required: ["tema"],
    };
  },
  handler: async (args: { tema: string }) => {
    const todas = await listFaq();
    const entrada = todas.find((f) => f.tema === args.tema);
    const respuesta =
      entrada?.respuesta ?? "Todavía no tengo esa información — dale la pregunta al equipo de La Julita.";
    return { result: respuesta, reply_to_user: respuesta };
  },
};
