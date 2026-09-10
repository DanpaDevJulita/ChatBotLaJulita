-- [2026-09-10] Reglas de escalamiento a humano — punto 3 de la lista, con las notificaciones
-- del punto 4 incluidas (el usuario pidió los dos juntos).
--
-- Qué agrega: dos columnas en `estado_conversacion` para saber si una conversación está
-- actualmente escalada a una persona del equipo, y cuándo fue la última vez que el bot le
-- avisó al CLIENTE que sigue en manos del equipo (para no repetirle el mismo mensaje en
-- cada mensaje suyo mientras espera).
--
--   escalado_en             — NULL = no está escalada. Con fecha = está esperando a una
--                              persona del equipo desde ese momento.
--   ultimo_aviso_humano_en  — última vez que el bot le confirmó al cliente "seguís con el
--                              equipo" (para espaciar los avisos, no repetirlo en cada mensaje).
--
-- Se resetean las dos a NULL con el comando /resuelto <numero> (ver comandos.ts) — así el
-- bot vuelve a atender normal a ese cliente desde el siguiente mensaje.

alter table estado_conversacion
  add column if not exists escalado_en timestamptz,
  add column if not exists ultimo_aviso_humano_en timestamptz;
