-- ============================================================================================
-- Horarios de check-in / check-out para la tabla `configuracion` (está creada pero vacía).
-- Generado el 2026-09-08 durante la auditoría.
--
-- Por qué hace falta: hoy el bot le responde "esa info todavía no la tengo a la mano" cuando
-- le preguntan por el check-in, aunque el horario está escrito dentro de la descripción de
-- cada plan. Con estas dos filas cargadas se puede reactivar la herramienta
-- `consultar_horarios` (descomentar su línea en src/core/tools/registry.ts y ajustar
-- prompts/system.md) y el bot pasa a contestarlo solo.
--
-- OJO: estos valores salen de las descripciones de los planes de una y dos noches. Los
-- pasadías tienen horarios distintos (entrada 9:00/10:00 am, salida 5:00/6:00/7:00/8:00 pm
-- según el plan), así que confirmá el texto antes de correr esto.
-- ============================================================================================

insert into configuracion (clave, valor) values
  ('checkin',  'las 3:00 pm (última hora de llegada 8:00 pm)'),
  ('checkout', 'medio día')
on conflict (clave) do update set valor = excluded.valor, updated_at = now();

select * from configuracion;
