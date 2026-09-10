-- ============================================================================================
-- PARTE 15 — edad de acompañantes y cupo real de adultos/niños en planes familiares (2026-09-10)
--
-- Hasta hoy `registrar_datos_reserva` guardaba cuántas `personas` eran en total, pero nunca
-- cuántas de esas eran niños — todo se mandaba a LobbyPMS como adultos (ver la nota "todos los
-- huéspedes se mandan como adultos" en REGLAS-RESERVAS-LOBBY.md, ya corregida). Esta columna
-- guarda cuántos de los acompañantes son menores de 18, solo para planes familiares o de amigos
-- (los únicos donde el bot pide la edad — ver src/agentes/ventas/herramientas/reserva.ts). En
-- cualquier otro plan queda en null/0: se sigue asumiendo que todos son adultos, como siempre.
--
-- Correr en Supabase → SQL Editor → pegar → Run.
-- ============================================================================================

alter table bloqueos_temporales
  add column if not exists ninos integer;

select 'bloqueos_temporales (con columna ninos)' as tabla, count(*) from bloqueos_temporales;
