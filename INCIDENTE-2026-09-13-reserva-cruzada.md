# Incidente 2026-09-13 — un cliente pudo recibir el link de pago de OTRO

## Qué pasó

Daniel probó el bot en WhatsApp: registró una reserva nueva (#7, plan de prueba de $5.000) y al
pedir pagar la mitad, el link que le llegó fue de **$190.000** — la mitad de OTRA reserva (#1,
de una prueba de días antes, de otro cliente, $760.000 total).

## Causa real (no era un bug de precios)

`enviar_datos_pago` confiaba en el `reserva_id` que el MODELO escribiera en su llamada a la
herramienta. En una conversación larga (varias reservas de prueba seguidas en el mismo chat), el
modelo repitió un `reserva_id` viejo en vez del de la reserva recién creada. Como esa reserva
vieja ya tenía un link de pago pendiente sin pagar, `conseguirLink` lo reusó tal cual (así está
pensado: si el cliente vuelve a pedir el link, se le reenvía el mismo en vez de crear otro) — el
cliente recibió el link, y el monto, de la reserva equivocada.

Es un bug de **autorización**, no de cálculo: nada validaba que el `reserva_id` perteneciera a
quien estaba escribiendo.

## Arreglo

1. **Primera versión (mismo día, urgente):** un Map en memoria del proceso que recuerda qué
   reserva registró cada conversación.
2. **Versión de fondo (pedida por Daniel, pensando en 200+ conversaciones a la vez y más de un
   proceso corriendo el bot):** ese dato ahora vive en la tabla `estado_conversacion`
   (`reserva_activa_id`, `reserva_activa_en` — ver `sql/reserva-activa.sql`), la misma tabla
   donde ya vivía el `last_agent` del orquestador. Es la fuente de verdad COMPARTIDA en la base,
   no la memoria de un proceso: sirve igual con uno o con diez procesos del bot corriendo en
   paralelo, y sobrevive un reinicio.
3. `registrar_datos_reserva` anota la reserva activa apenas la crea. `enviar_datos_pago` y
   `preguntar_forma_de_pago` usan esa reserva de la conversación POR ENCIMA de cualquier
   `reserva_id` que el modelo mande — si no coincide, se ignora el del modelo y queda un
   `console.warn` en los logs (nunca se lo hace notar al cliente).

## Estado

- Código: `conversacionActivaRepo.ts` (nuevo), `estadoRepo.ts` (+2 funciones), `pago.ts`,
  `reserva.ts` — ya entregados y escritos en el repo.
- Prueba nueva: `pruebas/e2e-reserva-activa.ts` (`npm run prueba:reserva-activa`) — reproduce el
  bug exacto y confirma que queda bloqueado. Los 46 casos de toda la suite (existentes + este)
  pasan.
- **Pendiente de Daniel:** correr `sql/reserva-activa.sql` en el SQL Editor de Supabase (agrega
  2 columnas a `estado_conversacion`, es un `ADD COLUMN IF NOT EXISTS`, se puede correr varias
  veces sin romper nada) y reiniciar el proceso del bot para que cargue el código nuevo.
- La fila vieja y peligrosa (`pagos.id = 2`, reserva #1, el link de $190.000) ya quedó anulada en
  la base — ese link no se puede volver a cobrar.

## Por qué esto importa para la escala (200+ conversaciones en paralelo)

Un Map en memoria no sirve con más de un proceso/réplica del bot (el balanceador puede mandar el
turno del pago a un proceso que nunca vio el registro) ni sobrevive un reinicio. Guardarlo en la
base es lo que lo hace correcto sin importar cuántos procesos corran el bot a la vez — la prueba
de concurrencia existente (`npm run prueba:concurrencia`) ya confirma además que los turnos de UN
MISMO cliente se procesan en orden (nunca en paralelo entre sí), así que no hay carrera posible
sobre el mismo `reserva_activa_id`.
