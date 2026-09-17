# Encerrar al bot: que solo alcance las tablas que necesita

## El problema, en una frase

El bot se conecta con `SUPABASE_SERVICE_ROLE_KEY`. Esa llave tiene el atributo
`BYPASSRLS`, o sea que **ignora cualquier política de seguridad** y puede leer y
escribir todas las tablas del proyecto, incluidas `users`, `roles`, `permisos` y
`bitacora_cambios` del panel. Mientras el bot use esa llave, no hay regla que lo
frene: restringirlo pasa por cambiarle la llave, no por agregar políticas.

## Qué necesita el bot de verdad

Revisé las 27 tablas que toca el código y quedaron en tres grupos.

De **solo lectura** necesita el catálogo y lo que consulta para responderle al
cliente: planes, domos, clase_domo, adicionales, tipo_adicional, recargos,
politicas, faq, configuracion, promociones, plantillas_carousel,
fechas_bloqueadas, tipo_documento, estado, conversaciones y la vista
v_estado_cuenta.

De **lectura y escritura** necesita lo que va registrando mientras conversa:
mensajes, clientes, acompanantes, reservas, estado_conversacion,
bloqueos_temporales, correcciones, alertas_tecnicas, sesiones_equipo,
promociones_envios y pagos. Más las dos funciones de pago que llama por RPC,
`fn_crear_pago_pendiente` y `fn_registrar_pago_aprobado`.

Y **no necesita nada** de las tablas del panel.

## El hallazgo que simplifica todo

En el código hay escrituras al catálogo (upsert y delete sobre planes,
adicionales, faq, politicas, recargos, promociones). Rastreé quién las llama y
**todas salen de `src/web/admin/routes.ts`**, el panel viejo embebido en el bot.
El bot conversacional no escribe el catálogo ni una sola vez.

Ese panel viejo es justo el que reemplaza tu panel de Laravel. Así que al quitarle
al bot el permiso de escribir el catálogo, lo único que se rompe es un panel que
ya no usas. Si todavía lo tienes levantado, apágalo cuando hagas este cambio.

---

## Paso 1 — Crear el rol en la base

En Supabase, entra a **SQL Editor**, pega el contenido de
`sql/permisos-bot-rol-restringido.sql` y ejecútalo. Se puede correr varias veces
sin romper nada.

Al final imprime dos consultas de verificación. La primera lista lo que quedó
permitido para el bot; la segunda **tiene que volver vacía** — si devuelve filas,
el bot todavía alcanza tablas del panel.

## Paso 2 — Generar el token del rol

En Supabase ve a **Project Settings → API → JWT Settings** y copia el **JWT
Secret**. Después, en la carpeta del bot:

```bash
node scripts/generar-token-bot.mjs "<JWT_SECRET>" "wcjoqkvkdnueadkcbupr"
```

Imprime una línea `SUPABASE_BOT_KEY=eyJ...`. Ese token es un secreto: trátalo
como una contraseña.

Si tu proyecto ya migró a las llaves de firma asimétricas y no aparece el JWT
Secret, avísame y lo resolvemos por el otro camino.

## Paso 3 — Cambiar la llave en el bot

En `.env` del bot agrega el token nuevo y **deja la llave vieja donde está** por
ahora, para poder volver atrás en segundos:

```env
SUPABASE_BOT_KEY=eyJ...
```

En `src/core/db/supabase.ts`, línea 4, cambia:

```ts
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
```

por:

```ts
const key = process.env.SUPABASE_BOT_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
```

Así, si borras `SUPABASE_BOT_KEY` del `.env`, el bot vuelve solo al
comportamiento anterior.

## Paso 4 — Comprobar

Levanta el bot y verifica, en este orden:

1. Que arranque sin el warning de `[supabase] Faltan ...`.
2. Que responda una consulta de precios o de planes (lectura del catálogo).
3. Que la conversación quede guardada: revisa que aparezcan filas nuevas en
   `mensajes` y en `estado_conversacion`.
4. Que un integrante del equipo pueda identificarse por WhatsApp con el código
   secreto (escribe en `sesiones_equipo`).
5. Que el bot **no** pueda leer usuarios. Desde el SQL Editor:

```sql
set role bot_lajulita;
select count(*) from users;   -- debe fallar con "permission denied"
reset role;
```

## Si algo sale mal

Borra `SUPABASE_BOT_KEY` del `.env` y reinicia el bot: vuelve a la llave de
servicio y todo queda como antes. El rol y los permisos pueden quedarse creados
en la base sin molestar a nadie.

## Lo que este cambio no hace

No toca a Laravel. El panel se conecta directo por Postgres con el usuario
`postgres`, que salta RLS y conserva acceso completo a todo — incluido el
catálogo, que es lo que administra.

Y no unifica los usuarios del equipo. Las credenciales con las que alguien se
identifica ante el bot por WhatsApp siguen viviendo en `TEAM_LOGIN_USERS`, en el
`.env` del bot, separadas de la tabla `users` del panel. Eso quedó pendiente y lo
podemos hacer después si quieres.
