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
  /**
   * [2026-09-11] Nombre de OTRA herramienta que el modelo tiene que llamar en el hop
   * SIGUIENTE, sin escribirle nada al cliente en el medio (ej.: registrar_datos_reserva ->
   * enviar_datos_pago, para que el link salga en el mismo turno).
   *
   * Por qué existe: antes esto se pedía solo por texto (la `description` de la herramienta y
   * un campo `siguiente_paso` en el `result`), y en la práctica el modelo a veces igual
   * respondía con texto plano en vez de encadenar — el cliente se quedaba sin el link aunque
   * la reserva sí se hubiera creado. Con este campo, runTurn.ts fuerza el `tool_choice` del
   * próximo hop a esa herramienta puntual: el modelo YA NO PUEDE elegir responder con texto,
   * tiene que llamarla sí o sí. Se consume una sola vez (aplica solo al hop inmediatamente
   * siguiente), así que una herramienta solo debe ponerlo cuando de verdad haga falta encadenar.
   */
  forzarSiguienteHerramienta?: string;
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
  /**
   * [2026-09-14] Nombre del BOT DUEÑO real de esta herramienta — no necesariamente el agente que
   * la está llamando ahora mismo (varios bots la pueden importar, ver la convención en
   * src/agentes/postventa/agente.ts). Coincide con un valor de `decision.agente` del orquestador
   * (ver src/agentes/orquestador/prompt.md): "reservas", "pagos", "postventa", etc.
   *
   * Para qué sirve: con los bots separados, un `forzarSiguienteHerramienta` a veces termina
   * corriendo, DENTRO del turno de un bot, una herramienta que en realidad es de OTRO bot (ej.:
   * `reservas` fuerza `preguntar_forma_de_pago`, que es de `pagos`, para que el link no dependa
   * de un mensaje extra del cliente). Si no se corrige nada, el próximo mensaje corto del
   * cliente ("abono", "total") se queda "pegado" a `reservas` por la regla de Pegajosidad del
   * orquestador — y `reservas` no tiene las herramientas para seguir el pago. runTurn.ts usa este
   * campo para, al final del turno, dejar `last_agent` apuntando al dueño real de la ÚLTIMA
   * herramienta que corrió, en vez de al bot que el orquestador había clasificado al principio.
   *
   * Si se omite, se asume que la herramienta es del mismo agente que la declaró — así no hace
   * falta tocar ninguna herramienta que no participe de un encadenado entre bots distintos.
   */
  agenteDueno?: string;
}
