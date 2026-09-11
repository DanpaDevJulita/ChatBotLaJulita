# Referencia de la API de LobbyPMS (para el bot de La Julita)

> Fuente: documentación oficial en `https://app.lobbypms.com/api`, leída el 10/09/2026.
> Este archivo es un resumen orientado a lo que necesita nuestro bot. Ante cualquier duda, la
> fuente manda.
>
> **Reemplaza al `MENSAJE-SOPORTE-LOBBYPMS.md`**: casi todo lo que íbamos a preguntarle a
> soporte está documentado acá. Al final quedan las dos únicas dudas que siguen abiertas.

---

## Autenticación (y el bloqueador de la IP)

- Token: `api_token` como parámetro. Se obtiene en el panel:
  **Configuraciones → Usuarios, Permisos y API → Acceso Api → Ver API Token**
  (hace falta entrar como usuario **ADMINISTRADOR**).
- **Además hay que autorizar las IPs** desde donde se harán las peticiones, en esa misma
  sección: **Configuraciones → Usuarios, Permisos y API → Acceso Api**.
- Sin la IP autorizada, la API responde `403` con
  `["the <IP> trying to access the API is not set as a valid ip"]`.
- Con token inválido: `{"error":"Unauthenticated."}`.

Códigos que devuelve: 200, 201, 204, 206, 400, 401, 403, 404, 422, 500, 503.

---

## Lo que desbloquea cada endpoint en nuestro proyecto

### 1. Disponibilidad — `GET /api/v1/available-rooms`

Parámetros: `api_token`, `start_date` (YYYY-mm-dd), `end_date`, y opcionales `category_id`,
`page`, `paginate` (máx. 100).

> **⚠️ `end_date` es INCLUSIVO — es la ÚLTIMA NOCHE, no el día de salida.** Medido contra la API
> el 2026-09-11 con `scripts/diagnostico-cupo.ts`:
>
> ```
> start_date=2026-09-11  end_date=2026-09-11  ->  contesta por 1 fecha:  el 11
> start_date=2026-09-11  end_date=2026-09-12  ->  contesta por 2 fechas: el 11 y el 12
> ```
>
> O sea que para UNA noche hay que mandar `start_date` y `end_date` con la MISMA fecha; para N
> noches, `end_date = entrada + (N - 1)`. El código asumía lo contrario (rango `[entrada, salida)`)
> y pedía una noche de más: como el bot exige cupo en todas las noches del rango (toma el mínimo),
> le decía al cliente "no hay cupo" cada vez que la noche SIGUIENTE estaba llena. Caso real: el
> DOMO FAMILIAR del 11 de septiembre tenía 1 unidad libre y el 12 tenía 0, y el bot lo reportó sin
> cupo. Corregido en `consultarDisponibilidadPorDia`.

**Forma real de la respuesta** (importante: NO es un arreglo plano como sugería el informe del
n8n — las categorías vienen anidadas dentro de cada fecha):

```
{ "data": [ { "date": "2020-09-12",
              "categories": [ { "category_id": 2523,
                                "name": "King",
                                "available_rooms": 3,
                                "prices": [ { "people": 1, "value": 320 }, ... ],
                                "restrictions": { "min_stay": 0, "max_stay": 0, "lead_days": 0 } } ] } ],
  "meta": { "total_records": 1, "current_page": 1, "records_per_page": 100, "total_pages": 1 } }
```

Lo que nos aporta, además del cupo por día:
- **`category_id`** — imprescindible para bloquear y para crear reservas (el nombre no sirve ahí).
- **`prices` por cantidad de personas** — la tarifa que LobbyPMS tiene cargada. Nosotros
  cotizamos con los precios de Supabase, así que esto sirve para **detectar diferencias** entre
  el catálogo del bot y lo que está cargado en LobbyPMS.
- **`restrictions.min_stay`** — si es mayor que las noches que pide el cliente, esa categoría no
  se puede vender para esa estadía aunque figuren unidades libres.

Existe también **`GET /api/v2/available-rooms`**, igual pero con las tarifas agrupadas por plan
(las estándar van en el plan `STANDARD_RATE`). Útil si algún día cotizamos con los planes de
LobbyPMS en vez de los nuestros.

### 2. Bloqueo de cupo — `POST /api/v1/block`  ← el bloqueo real de 10 minutos

Parámetros (JSON): `api_token`, `category_id`, `start_date`, `end_date`, y opcionales
`number_rooms` (por defecto 1), **`time` (minutos que se mantiene el bloqueo — si no se envía,
LobbyPMS usa 60)** y `note`.

> **⚠️ `end_date` acá también es la ÚLTIMA NOCHE, no el día de salida.** La evidencia es el propio
> calendario: un bloqueo de 1 noche creado con `start_date=11` y `end_date=12` quedó pintado como
> "Blo..." en las DOS celdas (11 y 12), o sea apartó dos noches. Para una noche va la misma fecha
> en los dos parámetros. Corregido en `crearBlockLobby` (`fechaUltimaNocheISO`).

Respuesta: `{ "blocked_ids": [123456], "rooms": [ { "room_id": 123456, "block_id": 123456 } ] }`

> **Este era el "1 hora" que había que cambiar a 10 minutos**: es el valor por defecto de
> LobbyPMS. Enviando `time: 10` queda como lo definió el equipo, y el bloqueo es visible para
> los vendedores en el calendario (a diferencia de nuestro candado interno actual).

### 3. Liberar bloqueo — `DELETE /api/v1/block/{block_id}`

Parámetros: `api_token`. Respuesta: `{ "delete_block": true }`.
Sirve para liberar el cupo antes de que expire (el cliente confirmó y se creó la reserva, o
dijo que no).

### 4. Crear reserva — `POST /api/v1/bookings`

Parámetros (JSON): `api_token`, `category_id`, `start_date`, `end_date`, `total_adults`
(requeridos); opcionales/condicionales: `total_children`, `holder_name` (requerido si el cliente
no existe en la propiedad), `customer_document` (si el cliente ya existe), `customer_nationality`
(requerido junto con `customer_document`, código ISO 3166-1), `rates_per_day`
(`[{date, price}]`), `note`, **`payment`** (monto del pago asociado, menor o igual al total — es
donde va nuestro anticipo del 50%) y **`channel`** (id del canal de venta, de
`/api/v1/channels` — sirve para distinguir en LobbyPMS lo que entra por el bot).

Respuesta: `{ "data": [ { "idBooking": 955088, "idRoom": 90546 } ], "meta": [] }`

### 5. Detalle de una reserva — `GET /api/v1/bookings/{booking_id}`

Devuelve la reserva completa, con los campos **en español**: `id_reserva`, `fecha_creacion`,
`estatus`, `fecha_ingreso`, `fecha_salida`, `checkin_realizado`, `checkout_realizado`,
`numero_personas`, `tarifas_por_dia`, `descuentos`, `impuesto_alojamiento`, `agencia`, `cuarto`,
`categoria`, `cliente` (con `identificacion`, `nombre`, `telefono`, `email`, `tipo_documento`),
`huespedes[]`, `ventas`, `grupo`.

**Ojo:** es por ID. La documentación **no** describe un listado de reservas por rango de fechas
(ver "dudas abiertas").

### 6. Cancelar reserva — `POST /api/v1/cancel-booking/{booking_id}`

Parámetros: `api_token`, `cancellation_reason` (requerido) y `description` (opcional).
Motivos: `NS` no show, `RC` cambio de habitación, `RE` errores en el registro, `TTC` cancelación
oportuna del cliente, `CC` cliente sin comunicación, `OTH` otros.

Errores relevantes: `UNAUTHORIZED_BOOKING` (**solo se pueden cancelar por API las reservas
creadas por la API**), `BOOKING_CHECK_IN_COMPLETE` (ya tiene check-in),
`RESTRICTED_RESERVATION` (tiene pagos o cargos extra).

> Dato importante para postventa: una reserva cargada a mano por un vendedor **no** se puede
> cancelar desde el bot. Ese caso siempre va a necesitar a una persona.

### 7. Catálogo (para mapear con Supabase)

- **`GET /api/v1/rooms`** — categorías con `category_id`, `name`, `type`, `capacity`, `quantity`,
  descripciones, fotos y las habitaciones individuales (`rooms[].id`, `name`). **Es de acá que
  hay que sacar los `category_id` reales de La Julita** (chalet, domo romantic, domo deluxe,
  domo familiar).
- **`GET /api/v1/rooms/status`** — estado del día: `checkin_today`, `checkout_today`, `in_house`,
  `no_guest`, cada uno con `category_id`, `room_id`, `blocked`, `notes`. Muy útil para el
  postventa de "dudas durante la estadía": permite saber quién está alojado hoy.
- **`GET /api/v1/products`** — productos/servicios de venta online: `service_id`, `name`,
  `value`, `stock`. Son los adicionales del lado de LobbyPMS.
- **`GET /api/v1/rate-plans`** — planes de tarifa con su ajuste (1 aumento %, 2 aumento fijo,
  3 descuento %, 4 descuento fijo), `min_stay` y restricción de fechas de check-in.
- **`GET /api/v1/channels`** — canales de venta habilitados (`channel_id`, `name`).
- **`GET /api/v1/documents`** — tipos de documento con su id: 1 Tarjeta de identidad,
  2 Cédula de ciudadanía, 3 Pasaporte, 4 Cédula de extranjería, 5 DNI, 6 NIT. **Hay que mapearlos
  con nuestra tabla `tipo_documento`.**
- **`GET /api/v1/occupancy`** y **`/daily-occupancy`** — estadísticas de ocupación (máx. 90 días
  por consulta; fechas en UTC que coincidan con las 00:00 de la propiedad).

### 8. Crear cliente — `POST /api/v1/customer/{type}`

`type` 1 = persona, 2 = empresa. Requeridos: `api_token`, `customer_document`,
`customer_nationality` (ISO 3166-1), `name`, y `surname` (salvo empresa). Opcionales:
`document_id` (de `/documents`), `birthdate`, `second_surname`, `gender` (male/female), `phone`
(con código de país, ej. `+573001245678`), `email`, `activities`, `address`, `note`.

### 9. Agregar consumos a una reserva — `POST /api/v1/booking/add-product-service`

`api_token`, `booking_id`, `items[]` con `product_id`, `cant` y opcional
`inventory_center_id`. Respuesta: `{ "sale": { "id": ..., "total": ... } }`.

> Es el **upsell de adicionales de postventa** hecho de verdad: hoy el bot solo puede
> mencionarlos; con esto puede sumarlos a la reserva.

### 10. Enlaces de pago — `/api/v1/payment/link`

- `POST` con `booking_id` y `amount` (≥ 6), opcional `expire_in` (Y-m-d, futura, máx. 12 meses;
  sin ese campo el enlace vence en 24 h). Devuelve `id`, `status`, `expire_in`, `ttl_hours` y la
  **`url`** de pago (`https://engine.lobbypms.com/payment/<uuid>`).
- `GET` con `booking_id` (o `id`) y opcional `status` — estados: `OPEN`, `DELETED`, `EXPIRED`,
  `APROVED`, `REJECTED`.
- `DELETE /api/v1/payment/link/{linkId}` — solo si está en `OPEN`.
- Reglas: solo un enlace `OPEN` por reserva; el monto no puede superar la deuda pendiente; la
  propiedad debe tener un sistema de pago configurado.
- La documentación menciona autenticación por token Bearer para este grupo, pero los parámetros
  listan `api_token`: hay que confirmarlo al probar.

> **Esto es el Agente de Pagos casi completo** (fase que estaba `[PENDIENTE]`): el bot podría
> generar el enlace de pago real del anticipo y, con el `GET`, **saber si el cliente ya pagó**
> sin depender de que mande el comprobante.

---

## Dudas que siguen abiertas (lo único que queda por preguntar)

1. **¿Existe un listado de reservas?** `GET /api/v1/bookings` responde al método GET (lo
   confirmamos por `OPTIONS`: `GET, HEAD, POST`), pero la documentación solo describe el detalle
   por id. Si acepta filtros por rango de fechas o por documento, es la vía directa para
   sincronizar hacia nuestra tabla `reservas`. Hay que probarlo con la IP autorizada.
2. **¿Hay webhooks?** No están documentados. Si LobbyPMS puede avisarnos cuando un vendedor crea
   o modifica una reserva, evitaríamos tener que consultar periódicamente.

Si la 1 no existe y la 2 tampoco, el plan B para la sincronización es reconstruirla desde
`GET /rooms/status` (quién entra, quién sale y quién está alojado hoy) más el detalle por id de
las reservas que el propio bot haya creado.

---

## Qué hay que ajustar en nuestro código (detectado al leer esta documentación)

1. **Corregido ya:** el parser de `available-rooms` esperaba un arreglo plano
   (`{date, name, available_rooms}`), que es la forma simplificada que mostraba el informe del
   n8n. La real es `data[].categories[]`. También se agregó la lectura de `category_id`,
   `restrictions.min_stay` y el recorrido de páginas (`meta.total_pages`, `paginate=100`).
2. **Pendiente:** guardar los `category_id` reales de La Julita (de `GET /api/v1/rooms`) para
   poder bloquear y crear reservas. Hoy el mapeo del bot es por nombre.
3. **Pendiente:** mapear `GET /api/v1/documents` con nuestra tabla `tipo_documento`.
4. **Pendiente:** al crear la reserva, usar `channel` para que en LobbyPMS se distinga lo que
   entra por el bot.
5. **A tener en cuenta en postventa:** las reservas que no creó la API no se pueden cancelar por
   API (`UNAUTHORIZED_BOOKING`) — ese caso necesita a una persona del equipo.
