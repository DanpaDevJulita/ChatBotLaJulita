/**
 * Mismo molde que src/tools/*.ts en agente-ycloud-main: una herramienta recibe argumentos
 * ya validados por el modelo y un contexto (quién escribe, en qué canal), y devuelve un
 * resultado. Si devuelve reply_to_user, ese texto se manda EXACTO al cliente — la IA no
 * lo puede reformular. Así se garantiza que un precio o una confirmación salgan siempre
 * tal cual el negocio los definió.
 */
export interface ToolContext {
  channel: string;
  externalId: string;
}

export interface ToolResult {
  result: unknown;
  reply_to_user?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * [2026-09-08] Si es true, el texto que devuelve la herramienta NO se manda literal: se le
   * pasa al modelo para que lo redacte con su propia voz (cálida, con preguntas, como escribe
   * una asesora de verdad). El pipeline verifica después que TODA cifra de dinero del mensaje
   * final exista en lo que devolvió la herramienta — así el tono es libre pero los precios
   * siguen saliendo de la base de datos, nunca de la cabeza del modelo (ver runTurn.ts).
   *
   * Sin esta bandera, el texto va literal: útil cuando la redacción exacta es parte del
   * negocio (un mensaje legal, un comprobante).
   */
  permitirRedaccion?: boolean;
  /** JSON Schema de los parámetros que puede pedir la IA (se usa si no hay getParameters, o si getParameters falla). */
  parameters: Record<string, unknown>;
  /**
   * Opcional: para herramientas cuyos parámetros válidos dependen de datos que cambian
   * (ej. la lista de temas de FAQ, que el equipo edita desde el panel de administración),
   * esto arma el JSON Schema al vuelo antes de cada llamada al modelo — así el modelo solo
   * puede elegir temas que existen de verdad.
   */
  getParameters?: () => Promise<Record<string, unknown>>;
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}
