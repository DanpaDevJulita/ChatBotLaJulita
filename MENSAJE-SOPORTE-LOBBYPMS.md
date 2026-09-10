# Mensaje para soporte de LobbyPMS (borrador listo para enviar)

> **[2026-09-10 — ACTUALIZACIÓN: este mensaje ya casi no hace falta.]**
>
> La documentación oficial de la API está en `https://app.lobbypms.com/api` (entrando al panel) y
> de ahí salió casi todo lo que este borrador pedía. El resumen quedó en
> **`REFERENCIA-API-LOBBYPMS.md`**, en la raíz del proyecto. En particular ya sabemos que:
>
> - `POST /api/v1/block` **sí acepta duración**: el parámetro `time`, en minutos (por defecto 60).
>   O sea, el bloqueo de 10 minutos se hace con `time: 10`, y se libera antes con
>   `DELETE /api/v1/block/{block_id}`.
> - `POST /api/v1/bookings` está documentado (`category_id`, fechas, `total_adults`, `payment`
>   para el anticipo, `channel` para marcar el origen).
> - Hay endpoints que no sabíamos que existían y nos sirven: enlaces de pago
>   (`/api/v1/payment/link`, que además permite **consultar si el cliente ya pagó**), agregar
>   consumos a una reserva, cancelar reserva, y estado de habitaciones del día.
>
> **Solo quedan dos preguntas abiertas.** Si hay que escribirle a soporte, es por estas dos —
> el resto del borrador se deja abajo nada más que como registro.

---

## Las dos preguntas que siguen abiertas

Buen día,

Somos La Julita Glamping (propiedad 16392). Estamos integrando nuestro asistente de WhatsApp con
la API v1 y ya trabajamos con la documentación de `app.lobbypms.com/api`. Nos quedaron dos dudas
que no encontramos ahí:

1. **¿Existe una forma de LISTAR reservas?** La documentación describe el detalle por id
   (`GET /api/v1/bookings/{booking_id}`), pero necesitamos traer las reservas de un rango de
   fechas (o buscarlas por documento del huésped) para sincronizarlas con nuestro sistema. El
   endpoint `GET /api/v1/bookings` responde al método GET: ¿acepta parámetros de filtro
   (fechas, documento, estado, o algún `updated_since`)? ¿Y paginación?

2. **¿Tienen webhooks?** Nos interesa que LobbyPMS nos avise a una URL nuestra cuando se crea,
   modifica o cancela una reserva —sobre todo las que cargan nuestros vendedores directamente en
   el sistema—, para no tener que consultar la API cada tanto.

Gracias.

La Julita Glamping

---

## (Registro) Borrador original, previo a encontrar la documentación

---

Buen día,

Somos La Julita Glamping (propiedad 16392 en LobbyPMS). Estamos conectando nuestro asistente de
WhatsApp a la API v1 (`https://api.lobbypms.com/api/v1`) con el token de nuestra cuenta.

Ya tenemos funcionando la consulta de disponibilidad (`GET /available-rooms`) y confirmamos que
la API exige autorizar la IP de origen. Para completar la integración necesitamos la
documentación de tres endpoints. ¿Nos pueden compartir el diccionario de datos?

**1. `POST /api/v1/bookings` — crear una reserva**
- Lista de campos obligatorios y opcionales, con tipos y formatos.
- Un ejemplo real de cuerpo de la petición (JSON o form-data, y cuál de los dos esperan).
- ¿Cómo se indica el alojamiento: por categoría (ej. "DOMO ROMANTIC") o por habitación
  específica? Si es por habitación, ¿hay forma de que LobbyPMS asigne una automáticamente
  dentro de la categoría?
- ¿Qué valores admite el estado de la reserva y cómo se registra un anticipo parcial con saldo
  pendiente (nosotros cobramos 50% de anticipo)?
- ¿Cómo se marca el canal/origen de la reserva, para poder distinguir en LobbyPMS las que entran
  por el asistente de WhatsApp de las que carga un vendedor?
- ¿Qué devuelve la respuesta (id de la reserva, código de confirmación)?

**2. `POST /api/v1/block` — bloquear cupo**
- Campos obligatorios y un ejemplo de cuerpo.
- ¿El bloqueo es por categoría o por habitación específica?
- **¿Admite una duración o fecha de expiración?** Necesitamos bloquear un cupo por 10 minutos
  mientras el cliente confirma el pago, y que se libere solo si no paga.
- Si no admite expiración: ¿cómo se libera un bloqueo (qué endpoint y con qué método)?
- ¿El bloqueo queda visible en el calendario para nuestros vendedores? Es justamente lo que
  buscamos: que un vendedor no venda el mismo domo que el asistente está a punto de reservar.

**3. `GET /api/v1/bookings` — consultar reservas**
- ¿Qué parámetros de filtro acepta? Nos interesan especialmente: rango de fechas, número de
  documento del huésped, teléfono, estado de la reserva, y algún `updated_since` o similar para
  traer solo lo que cambió desde la última consulta.
- ¿Cómo funciona la paginación y cuántos registros devuelve por página?
- ¿Qué campos trae cada reserva?

**4. Dos consultas adicionales**
- **Webhooks:** ¿LobbyPMS puede notificar a una URL nuestra cuando se crea, modifica o cancela
  una reserva? Si existe, lo preferimos a consultar la API periódicamente.
- **Restricción de IP:** el asistente va a correr en un servidor propio con IP fija. ¿La
  configuración de IPs autorizadas acepta varias direcciones y/o rangos (CIDR)? ¿Hay límite de
  cuántas se pueden registrar?
- **Límites de uso:** ¿hay un tope de peticiones por minuto/hora que debamos respetar?

Sobre `GET /available-rooms`, solo para confirmar: entendemos que `end_date` es el día de salida
y que la respuesta no incluye ese día (es decir, el rango es `[start_date, end_date)`, una fila
por día y por categoría). ¿Es correcto?

Quedamos atentos. Gracias.

La Julita Glamping
