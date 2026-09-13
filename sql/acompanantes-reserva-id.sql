-- ============================================================
-- Glamping La Julita - Chatbot
-- Devolver el vínculo acompañante -> reserva
-- ============================================================
-- [2026-09-11] Contexto: el 2026-09-08 el equipo borró `acompanantes.reserva_id` porque en ese
-- momento el bot NO creaba reservas (la reserva la armaba el equipo al asignar el domo), así que
-- colgar el acompañante de una reserva inexistente no servía de nada.
--
-- Eso cambió: con CREAR_RESERVA_DESDE_BOT=true el bot sí crea la fila de `reservas` (sin domo
-- asignado — `domo_id` quedó opcional en sql/pagos-migracion-reservas.sql), porque el módulo de
-- pagos necesita una reserva para poder cobrarla. Sin esta columna, los acompañantes quedan
-- sueltos: nadie puede saber a qué reserva pertenecen, y el mensaje del link de pago no puede
-- nombrarlos ("con Marcela y Efraín anotados").
--
-- Es ADITIVO y se puede correr varias veces sin romper nada:
--   - la columna es opcional (nullable), así que las filas que ya existen siguen válidas;
--   - no borra ni modifica ningún dato;
--   - ON DELETE SET NULL: si algún día se borra una reserva, el acompañante NO se borra con
--     ella, solo se queda sin vínculo.
-- ============================================================

ALTER TABLE acompanantes
  ADD COLUMN IF NOT EXISTS reserva_id integer;

-- La llave foránea se agrega aparte y con guarda, porque ADD CONSTRAINT no acepta IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'acompanantes_reserva_id_fkey'
  ) THEN
    ALTER TABLE acompanantes
      ADD CONSTRAINT acompanantes_reserva_id_fkey
      FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_acompanantes_reserva ON acompanantes(reserva_id);

-- Verificación (debe devolver la columna y la constraint):
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_name = 'acompanantes' AND column_name = 'reserva_id';
-- SELECT conname FROM pg_constraint WHERE conname = 'acompanantes_reserva_id_fkey';
