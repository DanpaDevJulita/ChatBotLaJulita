import OpenAI from "openai";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.warn("Falta OPENROUTER_API_KEY en tu .env — el bot no podrá llamar a la IA.");
}

export const openrouter = new OpenAI({
  apiKey: apiKey ?? "missing",
  // Configurable para poder apuntar a un servidor local al probar sin gastar
  // créditos ni depender de conexión real (ver DEV_TESTING.md).
  baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  // Sin esto, si el modelo (sobre todo uno gratis, que puede estar saturado) nunca
  // contesta, el bot se queda "pensando" para siempre en vez de avisar con un error.
  timeout: 30_000,
  maxRetries: 1,
});

export const LLM_MODEL = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-chat";

// El orquestador corre en CADA turno, antes que cualquier agente — conviene que sea un
// modelo rápido/barato (ver sección 12 del análisis). Por defecto usa el mismo modelo que
// los agentes para no exigir configuración extra; si más adelante quieren uno más barato
// específico para el router, basta con definir ORCHESTRATOR_MODEL en el .env.
export const ORCHESTRATOR_MODEL = process.env.ORCHESTRATOR_MODEL ?? LLM_MODEL;
