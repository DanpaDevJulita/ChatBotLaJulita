-- ============================================================================================
-- PARTE 11 — datos del cliente y sus acompañantes desde el bot (2026-09-08)
-- Verificado contra la estructura REAL de la base con scripts/estructura-db.ts
--
-- Cómo quedó el modelo, por decisión del equipo:
--   `clientes`      -> nombre, tipo de documento, número de documento y teléfono obligatorios;
--                      correo opcional. YA ERA ASÍ: no hizo falta cambiar nada.
--   `acompanantes`  -> lo mismo, con teléfono y correo opcionales. El equipo BORRÓ la columna
--                      `reserva_id`, porque el bot no crea reservas: la reserva la arma el
--                      equipo cuando confirma el cupo y asigna el domo.
--
-- Queda UN solo paso pendiente para que el bot pueda guardar. Correr en Supabase → SQL Editor.
-- ============================================================================================

-- `tipo_documento` está vacía y es llave foránea obligatoria en clientes y acompanantes: sin
-- una sola fila acá no se puede guardar ni un cliente ni un acompañante.
insert into tipo_documento (nombre, seudonimo) values
  ('Cédula de ciudadanía', 'CC'),
  ('Tarjeta de identidad', 'TI'),
  ('Cédula de extranjería', 'CE'),
  ('Pasaporte', 'PA'),
  ('NIT', 'NIT')
on conflict (nombre) do nothing;


-- Verificación
select 'tipo_documento' as tabla, count(*) from tipo_documento
union all select 'clientes', count(*) from clientes
union all select 'acompanantes', count(*) from acompanantes;
