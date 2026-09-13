# Bot de Pagos — sin construir todavía (pero el pago ya funciona, y ya se confirma solo)

Esta carpeta sigue reservada para un bot de Pagos propio. **No existe todavía y no es urgente**:
el tema `pagos` lo atiende el bot de **ventas** (ver `src/agentes/ventas/agente.ts`, campo
`atiende`), y ahí vive la herramienta que entrega los links.

## Qué se decidió el 2026-09-10

El módulo de pagos se parte en dos versiones, por decisión del equipo:

**Versión 1 — lo que ya está hecho.** Llega hasta **entregar el link de pago**, nada más.

- `src/agentes/ventas/herramientas/pago.ts` → herramientas `preguntar_forma_de_pago` y
  `enviar_datos_pago`.
- `src/core/db/pagosRepo.ts` → acceso a `pagos` y a la vista `v_estado_cuenta`.
- `src/core/integrations/boldClient.ts` → links de Bold.
- `sql/pagos-migracion-reservas.sql` + `sql/pagos.sql` → tabla `pagos` y funciones.

Es para pago con **cuenta débito, sin recargo**; el 6% de la tarjeta de crédito lo sigue
manejando el equipo por fuera.

### [2026-09-11] El cobro va en DOS pasos (antes era uno solo)

Hasta esta fecha se mandaba **un solo link, de monto ABIERTO**, y el cliente digitaba en la
página de Bold si abonaba el 50% o pagaba todo. Por pedido del negocio ahora se le **pregunta
primero** y el link sale **con el valor ya fijado**:

1. `preguntar_forma_de_pago` — le muestra las dos opciones con sus montos exactos (abono del 50%
   del saldo / saldo completo), sacados de `v_estado_cuenta`. No genera ningún link.
2. `enviar_datos_pago` con `modalidad="abono"` o `modalidad="total"` — crea el link en Bold en
   modalidad **CLOSE** por ese valor exacto. Si el cliente cambia de idea, el link pendiente de
   la otra modalidad se anula para no dejar dos links vivos sobre la misma reserva.

**Por qué son dos herramientas y no un parámetro opcional:** desde que el link lleva el monto
fijado, mandarlo sin que el cliente haya elegido sería cobrarle un valor que nunca aceptó. Al
ser herramientas distintas, `registrar_datos_reserva` puede forzar (`forzarSiguienteHerramienta`,
ver `src/core/tools/types.ts`) la que SOLO pregunta: ese turno no puede terminar en un link
aunque el modelo quiera. Y como segunda red, `enviar_datos_pago` llamada sin una modalidad
válida devuelve la pregunta en vez de un link. Nada de esto depende de que el modelo obedezca el
prompt.

**Probado con** `npm run prueba:pago` (5 casos, incluye el modelo intentando saltarse la
pregunta y el modelo inventándose una modalidad). Esa prueba corre el pipeline real contra una
Bold simulada que registra exactamente qué se le pidió (`amount_type` y monto), así que verifica
de verdad que el link sale CLOSE y por el valor correcto.

**Versión 2 — el webhook, construido el 2026-09-11.** A pedido del negocio ("que funcione igual
que el bot de Sebas Raider, entregando el link Y validando la confirmación — lo único distinto
es que el nuestro es de monto modificable y el de él es fijo"):

- `POST /webhooks/bold` (en `src/web/server.ts`) recibe la notificación de Bold, verifica la
  firma (`verificarFirmaBold` en `boldClient.ts`) y, si el evento es `SALE_APPROVED`, llama a
  `registrarPagoAprobado` (`pagosRepo.ts`) → `fn_registrar_pago_aprobado` en la base. Esto
  actualiza `pagos.estado`, `reservas.monto_pagado/saldo_pendiente/estado_pago/estado_reserva`
  solo, sin que nadie del equipo tenga que tocar nada.
- Adaptado 1:1 de la lógica de firma del bot base (`agente-ycloud-main` / "Sebas Raider" —
  `lib/hash.ts` + `web/routes/webhooks.bold.ts`, carpeta conectada a esta sesión): Bold firma
  con HMAC-SHA256 sobre el body en Base64 en el header `x-bold-signature`, y como su doc no dice
  con certeza cuál llave firma, se prueban en orden `BOLD_WEBHOOK_SECRET`, `BOLD_API_KEY`,
  `BOLD_SECRET_KEY` y por último una llave vacía (así firma Bold en SANDBOX). El primer webhook
  real que llegue deja en los logs cuál de todas coincidió.
- **URL a configurar en el panel de Bold:** `<tu-url-pública>/webhooks/bold` (ver `.env.example`
  para el detalle de las llaves).
- **Diferencia clave con el bot base:** allá el monto era fijo por plan, así que el webhook solo
  necesitaba marcar "pagado" (binario). Acá el monto es variable (reserva) y puede pagarse en
  abonos, así que `fn_registrar_pago_aprobado` recalcula el saldo real cada vez — puede llamarse
  más de una vez por reserva (un abono, después el saldo) sin romper nada.
- **A propósito NO se agregó** una tabla de diagnóstico tipo `bold_webhook_log` (el bot base sí
  tenía una — quedó marcada como deuda técnica en `AUDITORIA-2026-09-08.md`, nunca se retiró):
  por ahora el diagnóstico es por consola (`console.log`/`console.error` en el handler). Si hace
  falta más trazabilidad una vez probado con un pago real, se agrega ahí mismo.
- **Aún sin probar con un pago real de punta a punta.** Falta: mandar un pago de prueba desde
  Bold (sandbox), confirmar en los logs qué llave firmó, y verificar en Supabase que `pagos` y
  `reservas` quedaron con los valores correctos.

Lo que sigue sin construirse:

- Un bot de pagos propio en esta carpeta.
- La expiración automática de un borrador sin pago (`reservas.expira_at` ya existe en la base,
  pero nadie lo revisa todavía).

## La pregunta abierta: Bold o LobbyPMS

`prompt-de-diseno.md` está escrito para Bold, y la versión 1 se construyó con Bold. Pero la API
de LobbyPMS también genera enlaces de pago —`POST /api/v1/payment/link`— y además permite
**consultar si el cliente ya pagó** con un `GET`, sin webhook y sin depender del comprobante.
Ver `REFERENCIA-API-LOBBYPMS.md`, sección 10.

Por qué no se usó esa vía todavía: el enlace de LobbyPMS exige un **`booking_id` que exista en
LobbyPMS**, y hoy el bot crea la reserva solo en Supabase. Hasta que el bot cree la reserva
también en LobbyPMS (pendientes 2, 3 y 4 de esa misma referencia: mapear `category_id`,
`documents` y `channel`), esa puerta está cerrada. Bold no depende de nada de eso, por eso es lo
que está andando hoy.

Cuando el bot sí cree reservas en LobbyPMS, vale la pena volver a mirar esto: con el `GET` de
LobbyPMS el webhook de Bold dejaría de hacer falta.

## Para construir el bot de pagos propio

Seguí los pasos de `../LEEME.md`, sacá `"pagos"` del `atiende` de ventas y llevate
`herramientas/pago.ts` a esta carpeta.
