# Bot de Pagos — sin construir todavía (pero el pago ya funciona)

Esta carpeta sigue reservada para un bot de Pagos propio. **No existe todavía y no es urgente**:
el tema `pagos` lo atiende el bot de **ventas** (ver `src/agentes/ventas/agente.ts`, campo
`atiende`), y ahí vive la herramienta que entrega los links.

## Qué se decidió el 2026-09-10

El módulo de pagos se parte en dos versiones, por decisión del equipo:

**Versión 1 — lo que ya está hecho.** Llega hasta **entregar el link de pago**, nada más.

- `src/agentes/ventas/herramientas/pago.ts` → herramienta `enviar_datos_pago`.
- `src/core/db/pagosRepo.ts` → acceso a `pagos` y a la vista `v_estado_cuenta`.
- `src/core/integrations/boldClient.ts` → links de Bold.
- `sql/pagos-migracion-reservas.sql` + `sql/pagos.sql` → tabla `pagos` y funciones.

Genera **dos links**: uno de monto cerrado por todo el saldo y uno de monto abierto para abonar
(Bold no tiene una modalidad intermedia). El anticipo sugerido es el 50% del saldo. Los links
son para pago con **cuenta débito, sin recargo**; el 6% de la tarjeta de crédito lo sigue
manejando el equipo por fuera.

**Versión 2 — pendiente, a propósito.** Nada de esto se construyó todavía:

- El **webhook de Bold** que confirma el pago. La función que lo recibe
  (`fn_registrar_pago_aprobado`) ya existe y está probada en `sql/pagos.sql`, pero no hay ruta
  HTTP que la llame. Mientras tanto **quien verifica que el dinero entró es el equipo**, mirando
  Bold. El bot nunca dice que una reserva quedó pagada.
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
