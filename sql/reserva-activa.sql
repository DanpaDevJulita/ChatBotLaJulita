-- ============================================================
-- Glamping La Julita - Chatbot
-- "Qué reserva quedó activa en cada conversación" — para no volver a cobrar la reserva
-- equivocada
-- ============================================================
-- [2026-09-13] Bug real: en una conversación larga, el modelo llamó a la herramienta de pago
-- con el reserva_id de OTRA reserva (de otro cliente, de una prueba de días antes). Como esa
-- reserva vieja tenía un link de pago sin pagar, el bot lo reenvió tal cual: el cliente recibió
-- el link -y el monto- de la reserva de OTRO.
--
-- El primer arreglo (mismo día) guardó esto en MEMORIA del proceso de Node. Funciona, pero
-- Daniel pidió ir a la raíz pensando en cuando haya alta concurrencia (200+ conversaciones a la
-- vez, y probablemente más de un proceso corriendo el bot): un Map en memoria NO sirve ahí,
-- porque (a) no se comparte entre procesos/réplicas — si el balanceador manda la respuesta del
-- pago a un proceso distinto del que registró la reserva, el proceso nuevo no sabe nada; y
-- (b) se pierde cada vez que el proceso se reinicia (un deploy, un crash).
--
-- La solución de fondo: este dato vive en la BASE, igual que el resto del estado de la
-- conversación (`estado_conversacion`, el `last_agent` que usa el orquestador para la
-- "pegajosidad"). Así CUALQUIER proceso, en cualquier momento, puede consultar o escribir la
-- reserva activa de una conversación — es la fuente de verdad compartida, no la memoria de un
-- proceso en particular.
--
-- Se puede correr varias veces sin romper nada (ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE estado_conversacion
  ADD COLUMN IF NOT EXISTS reserva_activa_id integer,
  ADD COLUMN IF NOT EXISTS reserva_activa_en timestamptz;

COMMENT ON COLUMN estado_conversacion.reserva_activa_id IS
  'La última reserva que ESTA conversación registró (registrar_datos_reserva). Los pasos de pago la usan como fuente de verdad por encima de cualquier reserva_id que el modelo mande, para que un cliente nunca pueda terminar pagando la reserva de otro.';
COMMENT ON COLUMN estado_conversacion.reserva_activa_en IS
  'Cuándo se anotó la reserva activa — para poder expirarla (ver TTL_MS en conversacionActivaRepo.ts): una venta no debería tardar más que unas horas, así que una reserva "activa" de hace varios días no se usa como si fuera de hoy.';

-- ============================================================
-- Verificación:
-- SELECT canal, external_id, reserva_activa_id, reserva_activa_en FROM estado_conversacion
--   WHERE reserva_activa_id IS NOT NULL ORDER BY reserva_activa_en DESC LIMIT 10;
-- ============================================================
