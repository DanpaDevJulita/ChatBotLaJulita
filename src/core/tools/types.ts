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
  /**
   * [2026-09-16] URL directa a un archivo de video (mp4) para mandar como VIDEO NATIVO de
   * WhatsApp — no un link de YouTube pegado en el texto. La diferencia importa: un link de
   * YouTube en texto depende de que WhatsApp logre rastrear la miniatura (nada garantizado, y
   * en la práctica falla seguido — ver el historial de bugs en planes.ts) y, aunque funcione,
   * al tocarlo el cliente SALE de WhatsApp y abre YouTube. Un video nativo (este campo) llega
   * con su propia miniatura siempre, y se reproduce ADENTRO de WhatsApp sin salir de la app.
   * runTurn.ts lo manda con `adapter.send({ videoUrl, text })` aparte del texto normal, así que
   * no pasa por la verificación de cifras ni por la redacción libre del modelo — es un archivo,
   * no texto que el modelo pueda inventar o alterar.
   */
  videoUrl?: string;
  /**
   * [2026-09-17] Igual que `videoUrl` pero para una IMAGEN nativa (jpg/png/webp): para los planes
   * que en el panel tienen una imagen en vez de video. runTurn.ts la manda con
   * `adapter.send({ imageUrl, text })` aparte del texto normal.
   */
  imageUrl?: string;
  /**
   * [2026-09-15] Mensaje de catálogo de WhatsApp (gratis, NO es plantilla de Marketing — ver
   * REFERENCIA-CATALOGO-WHATSAPP.md). `runTurn.ts` lo manda con `adapter.send({ catalogo })`
   * aparte del texto normal, DESPUÉS de la respuesta (y del video, si también hay). Cada
   * `retailerIds` tiene que venir de `planes.retailer_id` ya cargado — quien arma esto nunca
   * debe inventar un SKU que no exista en la base.
   */
  catalogoWhatsApp?: {
    body: string;
    header?: string;
    footer?: string;
    secciones: { titulo: string; retailerIds: string[] }[];
  };
  /**
   * [2026-09-17] Fuerza texto LITERAL para esta llamada puntual, aunque la herramienta tenga
   * `permitirRedaccion: true` a nivel general (ver ToolDefinition.permitirRedaccion). Por qué
   * hace falta un escape así: `consultar_planes` necesita redacción libre para el menú de
   * experiencias y la escalera de 3 planes (ahí sí conviene el tono cálido y variado de una
   * asesora) — pero en el DETALLE de un plan puntual la redacción libre ya causó tres bugs
   * reales, uno detrás de otro: mostró la descripción completa en vez de la corta, desordenó
   * video y texto, y la última vez reescribió la lista "Incluye" sin los emojis que se le
   * pusieron a propósito Y encima repitió el link del video nativo en texto (que
   * `result`/`texto_base` nunca tienen — el modelo lo reconstruyó él solo, probablemente
   * copiándolo de un turno anterior de la misma charla). Ya no vale la pena perseguir cada
   * síntoma nuevo: cuando el texto que arma la herramienta importa cifra por cifra, línea por
   * línea, la única garantía real es no pasarlo por el modelo. Con este campo en `true`,
   * runTurn.ts manda `reply_to_user` tal cual, igual que si la herramienta entera tuviera
   * `permitirRedaccion: false`, sin tocar el resto de las respuestas de la misma herramienta.
   */
  forzarTextoLiteral?: boolean;
  /**
   * [2026-09-18] Segundo mensaje de WhatsApp, para cuando `reply_to_user` es un texto LITERAL
   * largo (políticas, términos) que se lee mejor partido en dos burbujas que en una sola pared
   * de texto. NO es para textos con redacción libre (el modelo ya controla su propio largo) ni
   * para nada que dependa de un video (ver LIMITE_CAPTION_WHATSAPP / partirParaCaption en
   * enviar.ts, que resuelve el caso del video con su propio mecanismo). runTurn.ts lo manda
   * como un `enviarSeguro` aparte, DESPUÉS de `reply_to_user`, solo cuando la herramienta no
   * usó redacción libre — mismo criterio que `forzarTextoLiteral`.
   */
  textoAdicional?: string;
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
