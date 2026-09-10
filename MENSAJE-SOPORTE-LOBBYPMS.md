# Mensaje para soporte de LobbyPMS (borrador listo para enviar)

> Para: soporte / equipo técnico de LobbyPMS
> De: La Julita Glamping
> Objetivo: obtener el diccionario de datos de la API v1 para terminar la integración del
> asistente de WhatsApp (disponibilidad, reservas y bloqueo de cupo).
>
> Cómo usarlo: copiá el bloque de abajo tal cual (o pegalo en el chat de soporte). Está redactado
> para que puedan responder puntualmente sin varias vueltas de correo.

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
