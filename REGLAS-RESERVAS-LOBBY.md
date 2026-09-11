# Bloqueo y reserva REALES en LobbyPMS — puntos 1.2.c y 1.2.d

> [2026-09-10] Hasta hoy `bloqueos_temporales` era un candado SOLO del bot: evitaba que el bot le
> prometiera el mismo cupo a dos clientes, pero no aparecía en el calendario de LobbyPMS — un
> vendedor podía vender el mismo domo sin enterarse. Esto completa lo que faltaba: el bloqueo de
> 10 minutos ahora también existe DENTRO de LobbyPMS, y al confirmar el pago el bot crea la
> reserva real. Se apoya en `REFERENCIA-API-LOBBYPMS.md` (la documentación real de la API, leída
> hoy) y en la decisión ya tomada con el equipo: **el bot crea la reserva real** (no solo un aviso
> al equipo para que la cargue a mano).

## 1. Qué pasa cuando el cliente da sus datos (`registrar_datos_reserva`, en `reserva.ts`)

Igual que antes: se guarda el cliente y los acompañantes, y se crea el candado interno de
siempre. **Nuevo**, antes de crear ese candado:

1. Se resuelve el `category_id` real de LobbyPMS para la clase+capacidad del plan, consultando
   `available-rooms` en caliente (`resolverCategoryId` en `lobbypms.ts`) — nunca hardcodeado, así
   que si LobbyPMS cambia sus ids esto se autocorrige solo.
2. Si se resolvió, se llama `POST /block` (`crearBlockLobby`) con `time: 10` (el mismo
   `BLOQUEO_MINUTOS` de siempre) — el bloqueo queda visible en el calendario de LobbyPMS.
3. El `block_id` y el `category_id` quedan guardados en la fila de `bloqueos_temporales` (columnas
   nuevas, ver `sql/bloqueo-lobby-real.sql`), junto con `cliente_id`, `personas` y `valor_total` —
   todo lo que hace falta para crear la reserva real después, sin volver a pedirle nada al
   cliente.

Es **mejor esfuerzo**: si la API oficial no está disponible (sin token, IP no autorizada, la
categoría no aparece para esa fecha), el paso 1-2 simplemente no pasa nada y el bot sigue con el
candado interno solo — exactamente como funcionaba antes de hoy. El cliente nunca se entera de
esto.

## 2. Qué pasa cuando el equipo confirma el pago (`/confirmar`, en `comandos.ts`)

Antes: `/confirmar` solo marcaba el candado interno como `confirmado` y cancelaba el aviso de
liberación. **Ahora, además**, llama a `crearReservaRealDesdeBloqueo` (`reservaLobby.ts`):

1. Trae el cliente de Supabase (`cliente_id` que quedó guardado en el paso anterior).
2. Crea/actualiza ese cliente en LobbyPMS (`POST /customer/1`) — así la reserva queda vinculada
   por documento (`customer_document`), no solo con un nombre suelto.
3. Crea la reserva real (`POST /bookings`): categoría, fechas, personas, el anticipo (50% de
   `valor_total`, igual que se le cotiza siempre al cliente) y una nota con el número del bloqueo
   interno, para poder rastrearla.
4. Si todo salió bien, libera el bloqueo real de LobbyPMS (`DELETE /block/{id}`) — la reserva ya
   ocupa el cupo, el bloqueo aparte ya no hace falta — y guarda el `booking_id`/`room_id` en el
   candado interno (solo trazabilidad).

El equipo ve el resultado en la propia respuesta de `/confirmar`:

```
Listo ✅ Confirmé el pago del bloqueo #42 — ya no se libera y no le mando el aviso de vencimiento.

✅ Reserva creada en LobbyPMS (#955088).
```

o, si algo falló:

```
⚠️ No pude crearla sola en LobbyPMS (este bloqueo no tiene la categoría de LobbyPMS guardada) —
hace falta crearla a mano en el panel.
```

**El pago queda confirmado pase lo que pase acá** — nunca se deshace `/confirmar` por un fallo de
LobbyPMS. Si falla, el equipo la crea a mano, como se hacía hasta ahora.

## 3. Si el bloqueo se vence sin que nadie confirme (`bloqueo.ts`, el worker)

Además de avisarle al cliente como siempre, si el candado tenía un `lobby_block_id`, se libera
también con `DELETE /block/{id}` — si no, quedaría "tomado" en el calendario de LobbyPMS aunque
el bot ya lo haya soltado por dentro.

## 4. Decisiones y simplificaciones a propósito

- **Nacionalidad: se asume Colombia (`CO`) para todos.** El bot no le pregunta la nacionalidad al
  cliente hoy. Si en algún momento hay huéspedes extranjeros que haya que distinguir, hay que
  empezar por ahí (agregar la pregunta en `registrar_datos_reserva`).
- **[2026-09-10, actualizado] Adultos y niños ya se distinguen — pero solo en planes familiares
  o de amigos.** Antes todos los huéspedes se mandaban como adultos (`total_adults`) y
  `total_children` quedaba siempre en 0. Ahora, si el plan es familiar o de amigos (ver
  `segmentoDePlan` en `planes.ts`), `registrar_datos_reserva` le pide al cliente la edad de cada
  acompañante (quien reserva siempre cuenta como adulto) y guarda cuántos son niños
  (`bloqueos_temporales.ninos`, ver `sql/bloqueo-edades-familia.sql`). Al crear la reserva real
  (`reservaLobby.ts`) eso se traduce en `total_adults`/`total_children` correctos. En pareja,
  solo y pasadía no se pregunta ni se usa — se sigue asumiendo que todos son adultos, como antes.
  Además, en planes familiares se aplica el cupo real que confirmó el equipo: hasta 3 personas si
  todas son adultas, o hasta 2 adultos y 2 niños (4 en total) — si no alcanza, el bot no registra
  la reserva y le pide al cliente hablar con el equipo (`cabeEnPlanFamiliar` en `reserva.ts`).
- **El cliente en LobbyPMS se crea recién en `/confirmar`, no antes.** A propósito: si se creara
  apenas el cliente da sus datos, cada intento de reserva que nunca se paga dejaría un "cliente
  fantasma" en LobbyPMS. Se crea solo cuando ya hay pago confirmado.
- **`channel` (canal de venta) es opcional** — `LOBBYPMS_CHANNEL_ID` en el `.env`. Sin
  configurarlo, la reserva se crea igual, solo que sin canal asignado en LobbyPMS. Para
  configurarlo hace falta consultar `GET /api/v1/channels` en el panel (la respuesta de este
  endpoint no tiene la forma esperada según lo visto en pruebas anteriores — hay que confirmarla
  a mano antes de fijar el id).
- **Bloqueo y reserva son siempre de 1 noche.** Igual que el candado interno de siempre — este
  flujo no cambia esa limitación existente, solo la conecta con LobbyPMS.
- **`rates_per_day` no se manda.** La reserva se crea sin forzar un precio por día — LobbyPMS usa
  su propia tarifa cargada. El valor que el bot le cotiza al cliente sale de Supabase y puede no
  coincidir con lo que LobbyPMS tiene cargado para esa categoría — es la misma discrepancia que ya
  se puede detectar comparando `prices` de `available-rooms` (ver `REFERENCIA-API-LOBBYPMS.md`),
  no algo nuevo de esta parte.

## 5. Lo que queda pendiente (fuera de alcance de hoy, a propósito)

- **1.2.b (sincronizar reservas de LobbyPMS hacia Supabase)** sigue sin resolver: la
  documentación no describe un listado de reservas por rango de fechas (`GET /bookings` solo
  trae detalle por id) — ver las dos preguntas abiertas en `MENSAJE-SOPORTE-LOBBYPMS.md`. Si
  soporte confirma que no existe, el plan B es reconstruirlo desde `GET /rooms/status`.
- **Enlaces de pago (`/api/v1/payment/link`)** — permitirían al bot generar el link de pago real
  del anticipo y saber si el cliente ya pagó sin depender del comprobante. No se tocó nada de
  esto hoy; es candidato natural para el Agente de Pagos.
- **Cancelar reserva (`POST /cancel-booking/{id}`)** — solo funciona para reservas creadas por la
  API. Con esta parte, las reservas que el bot cree SÍ se van a poder cancelar por API el día que
  se decida la política de cancelación (punto 5 de la lista general) — pero eso todavía no está
  definido y no se conectó nada de cancelación hoy.

## [2026-09-11] Tres arreglos después de probar con clientes reales

El caso que los destapó: el cliente pidió el 11 de septiembre para plan familiar, el bot contestó
"ya no tiene cupo" y en el calendario de LobbyPMS ese día SÍ tenía una unidad libre.

1. **`end_date` de LobbyPMS es la última NOCHE, no el día de salida.** El código asumía el rango
   `[entrada, salida)` y pedía una noche de más, así que el bot exigía que la noche SIGUIENTE
   también estuviera libre. El 11 tenía 1 libre y el 12 tenía 0 → reportaba sin cupo. Medido con
   `scripts/diagnostico-cupo.ts` y documentado en `REFERENCIA-API-LOBBYPMS.md`. Corregido en
   `consultarDisponibilidadPorDia` (consulta) y en `crearBlockLobby` (bloqueo).
2. **Cada bloqueo de 10 minutos apartaba dos noches** por el mismo motivo — en el calendario se
   veían las dos celdas en "Blo...". Además, un bloqueo abandonado que no se libera se queda
   comiendo inventario real: el diagnóstico ahora los lista y los puede liberar con
   `--liberar-bloqueo=<block_id>`.
3. **Se restaba dos veces el mismo cupo.** Desde que el bloqueo también es real en LobbyPMS, lo
   que devuelve `available-rooms` YA tiene descontado ese cupo; restarle encima el conteo del
   candado interno escondía disponibilidad. Ahora `contarBloqueosActivos` solo cuenta los
   bloqueos SIN `lobby_block_id`, que son los que LobbyPMS no conoce.

**Queda sin verificar (importante):** `POST /bookings` sigue mandando `end_date` como día de
salida. Si ese endpoint se comporta como los otros dos, cada reserva de 1 noche se crearía con una
noche de más. Todavía no se creó ninguna reserva real por API, así que no hay evidencia: antes de
la primera reserva de verdad hay que crear una de prueba y mirar cuántas noches ocupa en el
calendario. Está marcado con un `⚠️` en `reservaLobby.ts`.

## Archivos tocados

- `src/core/integrations/lobbypms.ts` — `resolverCategoryId`, `crearBlockLobby`,
  `liberarBlockLobby`, `crearOActualizarClienteLobby`, `crearReservaLobby` (nuevo, todo con el
  mismo contrato de "nunca lanza" del resto del archivo).
- `src/core/db/bloqueosRepo.ts` — columnas nuevas en `Bloqueo`/`NuevoBloqueo`, `crearBloqueo` las
  guarda, `guardarReservaLobby` (nuevo) guarda el `booking_id`/`room_id` al final.
- `src/core/db/reservasRepo.ts` — `obtenerTextoTipoDocumento` (nuevo): la inversa de
  `resolverTipoDocumento`, para mapear hacia LobbyPMS.
- `src/core/pipeline/reservaLobby.ts` (nuevo) — `crearReservaRealDesdeBloqueo`, todo el paso 2.
- `src/core/pipeline/comandos.ts` — `/confirmar` llama a `crearReservaRealDesdeBloqueo` y le suma
  el resultado a la respuesta para el equipo.
- `src/core/pipeline/bloqueo.ts` — libera el bloqueo real de LobbyPMS también al vencer.
- `src/agentes/ventas/herramientas/reserva.ts` — resuelve la categoría y crea el bloqueo real
  antes del candado interno.
- `sql/bloqueo-lobby-real.sql` (nuevo) — la migración; correrla en el SQL editor de Supabase.
- `.env.example` — `LOBBYPMS_CHANNEL_ID` (opcional).

## Edad de acompañantes y cupo real en planes familiares (agregado 2026-09-10, más tarde)

- `src/agentes/ventas/herramientas/planes.ts` — `segmentoDePlan` ahora exportada (hacía falta en
  `reserva.ts`).
- `src/agentes/ventas/herramientas/reserva.ts` — `PersonaArgs.edad` (nuevo); `cabeEnPlanFamiliar`
  (nuevo); si el plan es familiar o de amigos, pide la edad de cada acompañante y calcula
  adultos/niños; en plan familiar valida el cupo antes de registrar nada.
- `src/core/db/bloqueosRepo.ts` — columna `ninos` en `Bloqueo`/`NuevoBloqueo`, `crearBloqueo` la
  guarda.
- `src/core/pipeline/reservaLobby.ts` — usa `bloqueo.ninos` para mandar `total_adults`/
  `total_children` correctos a LobbyPMS (antes todo se mandaba como adultos).
- `sql/bloqueo-edades-familia.sql` (nuevo) — la migración de la columna `ninos`; correrla en el
  SQL editor de Supabase.
