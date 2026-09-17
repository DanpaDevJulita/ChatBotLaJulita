# REFERENCIA: Módulo de promociones (carousel de WhatsApp)

> [2026-09-15] Pedido de Daniel: reservar el carrusel de WhatsApp (ver
> `REFERENCIA-CAROUSEL-WHATSAPP.md`) solo para promociones, con un módulo aparte, y que el
> equipo lo dispare a mano cuando lance una oferta — no es algo que el bot mande solo durante
> una conversación normal.

Ya quedó implementado en el código (`bot-lajulita`). Esto es lo que se agregó y lo que falta
para dejarlo funcionando de verdad.

## Qué se agregó

| Archivo | Qué hace |
|---|---|
| `sql/promociones.sql` | Tablas `promociones` (el contenido: foto, texto, botón), `plantillas_carousel` (registro de qué plantillas ya aprobó Meta) y `promociones_envios` (historial de campañas). |
| `sql/promociones-imagenes-bucket.sql` | Bucket público de Supabase Storage para subir las fotos de las promociones (mismo patrón que ya usan para los videos de los planes). |
| `src/core/db/promocionesRepo.ts` | CRUD de promociones, de plantillas registradas, y el registro del historial. |
| `src/channels/whatsapp-ycloud/client.ts` | Nueva función `sendCarouselTemplate` — arma y manda el mensaje `type: "template"` con `carousel` a la API de YCloud. |
| `src/core/marketing/promocionesBroadcast.ts` | El corazón del módulo: valida que las promociones activas calcen con la plantilla elegida (mismo número de tarjetas, botón de link si la plantilla lo exige) ANTES de mandar nada, y si todo calza, envía uno por uno y deja registro. |
| `src/web/admin/routes.ts` | Rutas nuevas: `GET/PUT/DELETE /admin/api/promociones`, `GET/PUT/DELETE /admin/api/plantillas-carousel`, `POST /admin/api/promociones/vista-previa`, `POST /admin/api/promociones/enviar`, `GET /admin/api/promociones/envios`. |
| `src/web/admin/public/dashboard.html` + `admin.js` | Pestaña nueva "Promociones" en el panel: tabla de promociones, tabla de plantillas registradas, formulario para enviar una campaña, e historial de campañas enviadas. |
| `pruebas/e2e-promociones.ts` (`npm run prueba:promociones`) | Prueba automática: bloquea el envío si el número de tarjetas no calza o falta un link, y confirma que con todo en orden arma y manda el carousel a cada destinatario (sin repetidos), dejando registro. |

**Nada de esto manda un solo mensaje real todavía** — hasta que se complete el paso 2 de abajo,
la tabla `plantillas_carousel` está vacía y el panel va a avisar "no hay ninguna plantilla
activa registrada" apenas alguien intente enviar.

## Cómo queda el flujo de una campaña

1. El equipo carga las promociones vigentes en la pestaña "Promociones" (foto, texto corto,
   link opcional) y las marca "Activa".
2. El equipo elige, en "Enviar campaña", cuál plantilla usar y pega la lista de números.
3. Aprieta "Revisar" — el panel confirma si las promociones activas de hoy calzan con esa
   plantilla (mismo número de tarjetas, y si la plantilla exige link, que todas lo tengan).
4. Si todo calza, aprieta "Enviar campaña": manda el carousel uno por uno y muestra cuántos
   salieron bien y cuáles fallaron (con el error de cada uno).
5. Queda un registro en "Campañas enviadas" (fecha, plantilla, destinatarios, exitosos, fallidos).

Si el número de promociones activas no calza con ninguna plantilla registrada, el panel lo dice
ANTES de mandar nada — nunca manda "las que alcancen".

## Lo que falta — pasos manuales que el código no puede hacer solo

### 1. Correr las dos migraciones SQL
Desde el editor SQL de Supabase (o donde ya corren los `.sql` del proyecto):
```
sql/promociones.sql
sql/promociones-imagenes-bucket.sql
```

### 2. Crear y aprobar al menos una plantilla de carousel en YCloud
Esto es 100% manual — Meta tiene que aprobarla, el código no puede crear plantillas por su
cuenta. Seguir la sección 4 de `REFERENCIA-CAROUSEL-WHATSAPP.md` (Opción A, dashboard de
YCloud, es la más simple):
- Decidir cuántas promociones se van a mostrar a la vez (2 a 10) — ese número queda FIJO en la
  plantilla. Sugerido para empezar: 3.
- Formato de encabezado: **imagen** (ver la recomendación de la sección 2 de esa misma guía).
- Body de cada tarjeta con variable, ej.: `"{{1}}"` (para que el texto viaje dinámico y no haya
  que re-aprobar la plantilla cada vez que cambie una oferta).
- Un botón por tarjeta, tipo `URL` con variable (o quitar el botón de link y dejar solo
  respuesta rápida — en ese caso, al registrar la plantilla en el panel, marcar "¿Tiene botón de
  link?" → **No**).
- Enviar a revisión y esperar la aprobación de Meta.

### 3. Registrar la plantilla aprobada en el panel
Pestaña Promociones → "Plantillas de carousel aprobadas" → "Registrar plantilla", con el nombre
EXACTO que quedó en YCloud y la cantidad de tarjetas con la que se aprobó.

### 4. Subir las fotos y cargar las promociones
Subir cada foto al bucket `promociones-imagenes` (Supabase Storage → promociones-imagenes →
Upload file) y pegar la URL pública al crear cada promoción en el panel. Activar exactamente
tantas promociones como tarjetas tenga la plantilla registrada.

## Nota sobre la política de WhatsApp

Sigue aplicando lo que ya dice `REFERENCIA-CAROUSEL-WHATSAPP.md` (sección 6): es una plantilla
`MARKETING`, sujeta a los límites de mensajes de marketing y a las reglas de opt-in de Meta.
Como el disparo es siempre manual y a una lista que el equipo arma (no automático dentro de la
conversación con el bot), vale la pena que esa lista sea de clientes que ya dieron su número
esperando ofertas (reservas anteriores, formulario de contacto, etc.) — revisar el Business
Manager de Meta antes de mandar una campaña grande.
