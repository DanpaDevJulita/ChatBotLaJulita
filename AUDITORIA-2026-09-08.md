# Auditoría del bot y correcciones — 2026-09-08

Contexto: el bot respondía bien a los saludos pero **las preguntas de precios se quedaban sin
respuesta**, sin ningún error visible en la consola. Se auditó de punta a punta con
`scripts/diagnostico.ts`.

## Causa raíz (encontrada y corregida)

`consultar_planes` devolvía los 20 planes **con toda su descripción** ("Incluye: bienvenida,
desayuno, jacuzzi…") en un solo texto: **16.319 caracteres medidos**. Un mensaje de texto de
WhatsApp no puede pasar de **4.096**.

Lo insidioso: YCloud **acepta** la petición (HTTP 2xx), así que el trabajo de la cola terminaba
como *completed*, el bot creía haber respondido y el cliente **no recibía nada**. Por eso no
había error ni en la consola ni en los trabajos fallidos de BullMQ (0 fallidos en 7 días). Los
saludos, al ser cortos, sí llegaban — de ahí que pareciera un problema del orquestador o del
modelo.

Mensaje nuevo con los mismos datos: **2.164 caracteres**, entra en un solo envío.

## Hipótesis descartadas con datos

| Sospecha | Resultado real |
|---|---|
| Tablas de las PARTES 9/10 sin crear en Supabase | **Falso.** Todas existen (`mensajes` 24 filas, `estado_conversacion` 1, vista `conversaciones` OK). El comentario "SIN CORRER TODAVÍA" de `schema.sql` estaba desactualizado (ya corregido). |
| El modelo `deepseek/deepseek-v4-flash-0731` no existe | **Falso.** Está en el catálogo de OpenRouter (431 modelos) y responde. |
| El modelo no llama la herramienta | **Falso.** 12/12 llamadas correctas sobre 6 frases distintas de precios. |
| El orquestador enruta mal / no hay pegajosidad | **Falso.** 10/10 casos correctos, incluidos "somos 4" y "si" quedándose en el agente anterior. |
| Fallos silenciosos por excepciones sin capturar | **Real pero secundario.** Corregido; no era lo que rompía los precios. |

## Correcciones aplicadas

**Entrega de mensajes (la causa raíz)**

1. `src/core/tools/catalogo.ts` — `consultar_planes` con dos modos: sin argumentos devuelve la
   lista corta (nombre + precios); con el argumento `plan` devuelve el detalle completo de un
   plan puntual.
2. Los precios cargados como `0` (que significan "no aplica") ya no se muestran: antes el bot
   decía "fin de semana con puente **$ 0**".
3. `src/channels/whatsapp-ycloud/client.ts` — red de seguridad: cualquier texto de más de 3.900
   caracteres se parte en varios mensajes, cortando en párrafo/línea/espacio.

**Robustez del turno**

4. `runTurn.ts` — `try/catch` alrededor de la llamada al LLM y de cada herramienta, con logs
   detallados; el turno cae al mensaje de respaldo en vez de morir en silencio.
5. `runTurn.ts` — `enviarSeguro()`: un fallo de envío se loguea como "generado pero NO
   entregado", distinguible de un fallo del modelo.
6. `runTurn.ts` — el historial que se le manda al modelo se recorta a `HISTORY_TURNS` (20
   turnos); cuida no dejar resultados de herramienta huérfanos al cortar.
7. `mensajesRepo.ts` — `listMensajes` traía los mensajes **más viejos** (`ascending` + `limit`);
   ahora trae los más nuevos y los devuelve en orden cronológico.
8. `route.ts` — orquestador con `temperature: 0` (enrutamiento repetible). `runTurn.ts` usa
   `LLM_TEMPERATURE` (0.3 por defecto) para que el agente siga mejor las reglas.

**Prompts (se le estaban enviando notas internas al modelo)**

9. `prompts/orquestador.md` — se quitó el bloque "Notas de implementación" que le decía al
   router, falsamente, que él "todavía no existe". Las notas se movieron a `route.ts`.
10. `prompts/system.md` — se quitaron las notas internas ([NOTA INTERNA], [PENDIENTE]), se
    reescribió la regla de `consultar_planes` como obligatoria y con ejemplos, se documentó el
    argumento `plan`, y se aclaró que los precios **nunca** se contestan con "el equipo te
    confirma" (era justo la respuesta que se veía en WhatsApp).

**Configuración y panel**

11. `.env` — se agregaron `ADMIN_PASSWORD` y `SESSION_SECRET` (el panel `/admin` quedaba sin
    clave y firmaba cookies con el valor por defecto del código), más `PORT`,
    `YCLOUD_BASE_URL`, `YCLOUD_DRY_RUN`, `HISTORY_TURNS`. Se borraron dos llaves viejas de
    OpenRouter que quedaban comentadas y se quitó el espacio inicial de las líneas `YCLOUD_*`.
12. `src/web/admin/routes.ts` — las rutas de borrar plan/adicional pasaban el id como texto
    donde los repos esperan número; `npm run typecheck` fallaba por eso. Corregido.
13. `sql/schema.sql` — PARTES 9 y 10 marcadas como confirmadas.

**Herramienta nueva**

14. `scripts/diagnostico.ts` — banco de pruebas de punta a punta (`npx tsx
    scripts/diagnostico.ts`): configuración, las 17 tablas, las herramientas una por una
    **midiendo el largo de la respuesta contra el límite de WhatsApp**, validez del modelo, 12
    pruebas de tool-calling, 10 casos de enrutamiento, conversación completa de 8 turnos,
    firma y parseo del webhook, credenciales de YCloud y los trabajos fallidos de la cola.
    Deja el reporte en `diagnostico-<fecha>.txt`.

## Pendiente — datos del negocio (los tiene que revisar el equipo)

- **Errores de digitación en `planes`:** `PLAN UNA PERSONA UNA NOCHE DOMO DELUXE` tiene entre
  semana **$5.690.000** (su propia descripción dice $569.000) y `PASADIA BASICO ENTRE SEMANA`
  tiene **$3.690.000** (los otros pasadías van entre $419.000 y $639.000).
- **`PLAN FAMILIAR 4 PERSONAS`** tiene la descripción copiada del de 3 personas ("Desayuno
  para 3 personas", y los precios del texto no coinciden con las columnas).
- **`PLAN AMIGAS 3 PERSONAS`**: el texto dice fin de semana $790.000 / puente $890.000; las
  columnas dicen $760.000 / $930.000.
- **`capacidad` está vacía en los 20 planes** — por eso nunca se muestra "(hasta N personas)".
- **`configuracion` vacía** → el bot dice que no sabe el horario de check-in aunque está escrito
  en todas las descripciones. Cargar con `sql/configuracion-horarios.sql` y luego reactivar
  `consultar_horarios` en `registry.ts` + `system.md`.
- **`faq` vacía** → misma situación con ubicación, mascotas, etc.
- Rotar por precaución las credenciales que quedaron expuestas durante el trabajo (OpenRouter,
  YCloud, Supabase, Redis de Upstash).

## Cambio posterior: los planes se muestran de a 3, y preguntando primero

A pedido del equipo, `consultar_planes` dejó de ser un listado y pasó a ser conversacional:

- **Primero pregunta.** El prompt le pide al modelo preguntar *para cuántas personas es*
  antes de mostrar nada (con su propio texto, sin llamar la herramienta). Si el cliente ya lo
  dijo, no lo repregunta.
- **Después muestra 3.** Con `personas`, la herramienta devuelve **máximo 3 planes**, elegidos
  alternando tipos de alojamiento (chalet → clásico → deluxe) para que la primera tanda sea
  variada, y ordenados por exactitud: primero los armados justo para ese número de personas,
  después los que no tienen capacidad cargada, y al final los más grandes. Los que no alcanzan
  quedan afuera.
- **Sigue de 3 en 3.** El texto cierra con "¿Te muestro otros, o te cuento qué incluye alguno
  de estos?", y con `pagina` 2, 3… trae las tandas siguientes.
- **Detalle bajo pedido.** Con `plan` (aunque el cliente lo diga incompleto: 'paraiso',
  'familiar 3') devuelve todo lo que incluye ese plan. Si el nombre es ambiguo, ofrece los que
  coinciden en vez de adivinar.
- **Filtro opcional `tipo`:** `pasadia`, `una_noche` o `dos_noches`.

La clasificación por tipo de alojamiento y la capacidad salen de `planes.domos_id` →
`domos.clase` / `domos.capacidad_max`; mientras esas columnas estén vacías se deducen del
nombre y la descripción del plan (funciona, pero cargarlas lo vuelve exacto).

Tamaño medido de una tanda con los 20 planes reales: **entre 470 y 540 caracteres** (antes:
16.319 de una sola vez).

## Registro de los datos de la reserva (agregado a pedido del equipo)

Cuando el cliente decide reservar, el bot ahora toma y **guarda en la base**:

- **quien reserva** → tabla `clientes`: nombre completo, tipo de documento, número, **celular** y
  correo (opcional). El `unique(tipo_documento_id, numero_documento)` del schema hace que un
  cliente que ya vino antes se actualice en vez de duplicarse.
- **cada acompañante** → tabla `acompanantes`: nombre completo, tipo y número de documento
  (celular y correo opcionales).
- **la reserva que los une** → tabla `reservas`, con el plan, la fecha, el número de huéspedes y
  el valor de esa fecha, en estado **pendiente de pago**.

Herramienta nueva: `registrar_datos_reserva` (`src/core/tools/reserva.ts`) + repositorio
`src/core/db/reservasRepo.ts`.

**Tres obstáculos del schema y cómo se resolvieron** (SQL en `sql/reserva-datos-cliente.sql`):

1. `acompanantes.reserva_id` es NOT NULL → para guardar un acompañante tiene que existir antes
   la fila de `reservas`. Por eso la herramienta crea las tres cosas en un solo paso.
2. `reservas.domo_id` es NOT NULL, pero **cuál domo le toca al cliente depende de la
   disponibilidad real, que el bot no consulta**. Obligarlo a elegir uno sería inventar una
   asignación. Se quita el NOT NULL: la reserva nace sin domo y el equipo lo asigna al confirmar
   el cupo.
3. `tipo_documento` y `estado` estaban **vacías** y son llaves foráneas obligatorias. Se cargan
   los tipos usuales de Colombia (CC, TI, CE, PA, NIT) y los estados (pendiente de pago,
   confirmada, cancelada, completada).

Comportamiento cuidado en dos puntos: la herramienta **valida antes de escribir** (si dijeron que
son tres personas y solo hay datos de dos, pide los que faltan en vez de guardar a medias), y si
algo falla en la base el cliente **nunca ve el error técnico** — se le dice que el equipo sigue
con su caso y el detalle queda en los logs del worker.

## Aprendizaje asistido: corregir al bot desde WhatsApp

El equipo puede enseñarle cosas al bot por chat y aplican **con todos los clientes desde el
mensaje siguiente**, sin tocar código ni volver a desplegar.

Qué es y qué no es: el modelo NO se reentrena (sus pesos no se tocan). Las correcciones se
guardan en la tabla `correcciones` y se le inyectan al prompt como un bloque de sistema en cada
turno, con prioridad sobre el estilo del `system.md`. Efecto inmediato, global, reversible
(`/borra`) y auditable (queda quién enseñó qué y cuándo).

**Identificación.** Dos vías:

1. Atajo por número: los de `OWNER_WHATSAPP_NUMBERS` corrigen sin clave.
2. Desde cualquier número: se manda el **código secreto** (`TEAM_SECRET_CODE`), el bot pide
   **usuario y clave** (`TEAM_LOGIN_USERS`) y el número queda habilitado `TEAM_SESSION_HOURS`
   horas (sesión en la tabla `sesiones_equipo`, sobrevive a reinicios del worker).

**Comandos:** `/corrige <texto>`, `/correcciones`, `/borra <n>`, `/salir`, `/ayuda`.

**Cuidados de seguridad** (una clave escrita en WhatsApp queda en el chat, en la base de
mensajes y en los logs si uno se descuida):

- Los comandos se atienden ANTES de guardar el mensaje: el texto con la clave nunca entra a
  `mensajes` ni al historial que ve el modelo.
- Los logs registran el número y si acertó o no — **nunca la clave**.
- Las claves pueden guardarse como **hash sha256** en el `.env`.
- Máximo 5 intentos por número; después, 15 minutos de bloqueo.
- El bot le recuerda al usuario borrar el mensaje con la clave.
- Un número no identificado que escriba `/corrige ...` es tratado como cliente normal (queda un
  aviso en los logs). Sin esto, cualquiera podría "enseñarle" que hay 90% de descuento.
- Una corrección ajusta tono, palabras y detalles; **no** habilita inventar precios, prometer
  disponibilidad, ofrecer descuentos, mandar datos de pago ni decir que es una persona.
