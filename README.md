# Bot La Julita

Arquitectura basada en `agente-ycloud-main`, pero con el canal (WhatsApp, Instagram, un
CRM...) separado del bot: el bot (`src/core`) solo conoce `InboundEvent`/`OutboundMessage`
(definidos en `src/channels/types.ts`), nunca el formato de un canal específico. Ver
`ANALISIS_LA_JULITA.docx`, sección 11, para la explicación completa del porqué.

## Estructura

- `src/channels/` — un adaptador por canal: `console` (terminal) y `whatsapp-ycloud` (real,
  portado de `agente-ycloud-main`) implementan el mismo contrato (`ChannelAdapter`).
  `whatsapp-ycloud/client.ts` manda mensajes, `signature.ts` verifica la firma del webhook,
  `adapter.ts` junta todo y parsea los mensajes entrantes.
- `src/channels/registry.ts` — mapa nombre de canal → adaptador (igual patrón que las
  herramientas de la IA).
- `src/core/` — el bot: el prompt del Agente de Información (`prompts/system.md`), sus
  herramientas (`src/core/tools/`), el router/orquestador (`src/core/orchestrator/route.ts`,
  con su propio prompt en `prompts/orquestador.md`) y el pipeline que junta todo por turno
  (`src/core/pipeline/runTurn.ts`). No importa nada de `src/channels/*` directamente.
- `src/core/orchestrator/route.ts` — decide, en cada mensaje entrante, a qué agente le
  toca responder (`informacion`, `reservas`, `pagos`, `postventa` o `humano`) llamando al
  modelo con una herramienta `enrutar` de salida forzada. Guarda esa decisión en
  `estado_conversacion` (`src/core/db/estadoRepo.ts`) para no reclasificar a ciegas cada
  turno. Hoy solo `informacion` tiene herramientas reales — `reservas`/`pagos`/`postventa`
  ya se enrutan como tales (queda guardado en `estado_conversacion.last_agent` y en
  `mensajes.agent_name`) pero mientras no tengan sus propias herramientas construidas
  (ver `prompts/agentes/*.md`), los sigue atendiendo el Agente de Información. `humano`
  corta el flujo de una vez con un mensaje fijo (todavía sin notificación automática al
  equipo — pendiente).
- `src/web/` — el servidor que recibe el webhook de WhatsApp (`POST /webhooks/whatsapp`) y
  llama al mismo `handleInbound` que usa la consola. `src/web/admin/` es el panel de
  administración (ver sección propia más abajo).
- `src/core/db/` — todo lo que habla con Supabase: planes, adicionales, horarios/fechas
  bloqueadas, FAQ y el historial de mensajes. Tanto el bot (`src/core/tools/`) como el
  panel de administración (`src/web/admin/routes.ts`) leen/escriben a través de estos
  archivos — nunca directo a Supabase desde otro lado.
- `scripts/chat-local.ts` — punto de entrada para hablar con el bot desde la terminal.

## Cómo correrlo

```bash
npm install
cp .env.example .env
# completa OPENROUTER_API_KEY en .env (puede ser la misma cuenta de OpenRouter que ya
# usas en agente-ycloud-main)
npm run chat:local
```

## Probarlo sin gastar créditos de IA (opcional)

`scripts/mock-openrouter.mjs` es un servidor local que imita la respuesta de OpenRouter
(siempre llama a `preguntas_frecuentes`) — sirve para probar que el cableado
consola → bot → herramienta → respuesta funciona, sin llamar a la IA real. Así se probó
esta primera versión:

```bash
node scripts/mock-openrouter.mjs &
OPENROUTER_BASE_URL=http://localhost:8787/v1 OPENROUTER_API_KEY=test npm run chat:local
```

Escribe cualquier cosa y el bot debería responder con el texto de ejemplo de "ubicación".
Con esto confirmamos que: el mensaje escrito llega al pipeline, el modelo (simulado) pide
la herramienta `preguntas_frecuentes`, la herramienta se ejecuta y su respuesta se envía
tal cual por el adaptador de consola — exactamente el mismo camino que seguirá un mensaje
de WhatsApp real cuando conectemos ese canal.

## Conectar WhatsApp real (número de pruebas)

El servidor necesita una URL pública para que YCloud le mande los mensajes — como corre en
tu máquina, usamos **ngrok** como túnel temporal mientras programamos.

1. Completa en tu `.env`: `YCLOUD_API_KEY`, `YCLOUD_FROM_PHONE_NUMBER` (tu número de pruebas
   en formato `+573...`) y `YCLOUD_WEBHOOK_SECRET` (lo generas/copias al configurar el
   webhook en el paso 4).
2. Arranca el servidor: `npm run web` — por defecto en `http://localhost:3000`.
3. En otra terminal, expón ese puerto con ngrok (si no lo tienes: `npm install -g ngrok`,
   crea una cuenta gratis en ngrok.com y sigue sus instrucciones de `ngrok config
   add-authtoken ...` la primera vez):
   ```
   ngrok http 3000
   ```
   Te da una URL pública tipo `https://algo-random.ngrok-free.app` — cada vez que reinicies
   ngrok cambia, así que hay que volver a pegarla en YCloud cuando pase.
4. En la consola de YCloud, en la configuración del webhook de tu WABA, pon la URL:
   `https://algo-random.ngrok-free.app/webhooks/whatsapp`. YCloud debería mostrarte (o
   dejarte generar) el secreto de firma — cópialo en `YCLOUD_WEBHOOK_SECRET` de tu `.env`.
5. Manda un WhatsApp real a tu número de pruebas y mira la terminal donde corre `npm run web`
   — deberías ver el mensaje llegar y, si todo está bien configurado, la respuesta del bot en tu WhatsApp.

Antes de meterte con ngrok, puedes probar el servidor solo (localmente): con
`npm run web` corriendo, `node scripts/test-webhook.mjs` manda un webhook de WhatsApp
simulado, ya firmado correctamente — así confirmas que el servidor, la verificación de
firma y el bot funcionan antes de complicarte con el túnel público.

## Panel de administración (`/admin`)

Interfaz web donde el equipo de ventas edita precios/planes, adicionales, horarios de
check-in/check-out, fechas bloqueadas y las preguntas frecuentes — y donde se puede
revisar qué está hablando el bot con los clientes. El bot lee esos mismos datos (tablas de
Supabase) en cada mensaje, así que un cambio guardado ahí queda disponible para el bot al
instante, sin tocar código ni reiniciar el servidor.

### Configurarlo (una sola vez)

1. Crea una cuenta gratis en [supabase.com](https://supabase.com) y un proyecto nuevo.
2. En tu proyecto, ve al **SQL Editor** → "New query", pega todo el contenido de
   `sql/schema.sql` y dale "Run" (se puede correr varias veces sin problema, es idempotente
   — ya se probó corriéndolo dos veces seguidas contra un Postgres real). Crea:
   - Lo que el bot usa **hoy**: `planes` (los domos), `adicionales`, `configuracion`,
     `fechas_bloqueadas`, `faq`, `mensajes` y `estado_conversacion` (del orquestador).
   - El diseño **completo** para cuando se construyan los agentes de Reservas/Pagos/
     Postventa (`prompts/agentes/*.md`): `temporadas` (tarifas por época), `contacts`
     (identidad del huésped, separada del canal), `reservations`, `reserva_adicionales`,
     `pagos` y `politicas_cancelacion` — quedan creadas desde ya para no rediseñar el
     schema en cada fase, aunque el código todavía no las use. `equipo` queda lista para
     cuando se porte la notificación automática al escalar a humano (ver más abajo).
3. En **Project Settings → API**, copia la **Project URL** y la **service_role key**
   (¡no la `anon` `public`! — esa no sirve aquí) y ponlas en tu `.env`:
   ```
   SUPABASE_URL=https://tu-proyecto.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=tu-service-role-key
   ```
4. En tu `.env`, define también:
   ```
   ADMIN_PASSWORD=una-clave-que-inventes-para-el-equipo
   SESSION_SECRET=cualquier-texto-largo-y-aleatorio
   ```
5. Reinicia `npm run web` para que tome las variables nuevas.
6. Entra a `http://localhost:3000/admin` (o a tu URL pública + `/admin` si estás con
   ngrok/cloudflared) e inicia sesión con `ADMIN_PASSWORD`.

Si `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` no están configuradas, tanto el bot como el
panel siguen funcionando sin caerse — el bot responde "todavía no tengo esa información" y
el panel muestra un aviso de que nada se va a guardar hasta que las completes.

**Nota de seguridad:** la `service_role key` de Supabase tiene acceso total a la base de
datos — vive solo en el `.env` del servidor (que nunca se sube a git) y nunca debe
aparecer en código del navegador. El panel de administración usa una sola contraseña
compartida (`ADMIN_PASSWORD`) por ahora — suficiente para un equipo pequeño, pero sin
distinguir quién hizo cada cambio; si más adelante quieres cuentas individuales por
vendedor, se puede migrar a Supabase Auth.

## Estado actual / próximos pasos

- [x] Canal de consola para probar el bot sin WhatsApp.
- [x] Patrón de herramientas + FAQ, planes, adicionales y horarios conectados a Supabase.
- [x] Adaptador real de WhatsApp/YCloud (envío, verificación de firma, parseo de mensajes
      entrantes) y servidor web con el webhook.
- [x] Historial de conversaciones en Supabase (sobrevive a un reinicio del servidor).
- [x] Panel de administración (`/admin`): planes, adicionales, horarios, fechas
      bloqueadas, FAQ y monitor de conversaciones.
- [x] Orquestador (`src/core/orchestrator/route.ts` + `prompts/orquestador.md`): enruta cada
      mensaje a `informacion`/`reservas`/`pagos`/`postventa`/`humano`, con pegajosidad
      (`estado_conversacion.last_agent`) y trazabilidad (`mensajes.agent_name`). `humano`
      corta el flujo con un mensaje fijo; `reservas`/`pagos`/`postventa` ya se enrutan como
      tales pero, al no tener herramientas propias todavía, los sigue atendiendo el Agente
      de Información — falta construir esos 3 agentes de verdad (ver punto siguiente).
      **Requiere correr de nuevo `sql/schema.sql` en Supabase** (agrega `estado_conversacion`
      y la columna `mensajes.agent_name`, ambos con `if not exists`, no rompe lo que ya
      había).
- [ ] Completar los datos reales de La Julita desde el panel (`/admin`) — ubicación, cómo
      llegar, mascotas, precios reales, etc. Siguen con `[PENDIENTE]` hasta que el equipo
      los cargue.
- [ ] Construir los agentes de Reservas, Pagos y Postventa (diseño ya escrito en
      `prompts/agentes/*.md`, cada uno marca con `[PENDIENTE]` qué herramientas le faltan).
      La pieza más crítica es `verificarDisponibilidadFechas` — hoy `fechas_bloqueadas` es
      solo un registro, el bot todavía no la consulta ni hay cotización/reserva real.
- [ ] Notificación automática al equipo cuando el orquestador escala a `humano` (hoy solo
      queda en los logs del servidor) — portar el patrón de `leadNotify.ts` de
      `agente-ycloud-main`.
- [ ] Separar los procesos web/worker con una cola de verdad (BullMQ + Redis), como en
      `agente-ycloud-main` — hoy el webhook procesa cada mensaje directo, sin cola.
- [ ] Manejo de audio/imagen entrantes (hoy solo se detectan, no se transcriben/describen).
- [ ] Cuentas individuales por vendedor en el panel de administración (hoy es una sola
      clave compartida).
