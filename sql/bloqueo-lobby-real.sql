-- ============================================================================================
-- PARTE 14 — bloqueo y reserva REALES en LobbyPMS (2026-09-10)
--
-- Completa lo que sql/bloqueos-temporales.sql dejó pendiente: hasta hoy `bloqueos_temporales`
-- era un candado SOLO del bot (no tocaba LobbyPMS). Estas columnas guardan lo necesario para
-- que sea también un bloqueo real en LobbyPMS (POST /block) y, al confirmar el pago, una
-- reserva real (POST /bookings) — ver src/core/integrations/lobbypms.ts y
-- src/core/pipeline/reservaLobby.ts. Ninguna es NOT NULL: si la API oficial no está disponible
-- en el momento de crear el bloqueo, el bot sigue funcionando solo con el candado interno, como
-- hacía antes de esta parte.
--
-- Correr en Supabase → SQL Editor → pegar → Run.
-- ============================================================================================

alter table bloqueos_temporales
  -- A quién se le va a crear la reserva real cuando se confirme el pago (ver
  -- registrar_datos_reserva: ya se tiene el cliente_id apenas se registran los datos).
  add column if not exists cliente_id integer references clientes(id),
  -- Cuántas personas se hospedan (registrar_datos_reserva ya lo recibe) — hace falta para
  -- `total_adults` al crear la reserva en LobbyPMS.
  add column if not exists personas integer,
  -- El valor cotizado (el mismo que ya se le confirmó al cliente) — de acá sale el anticipo del
  -- 50% que se manda como `payment` al crear la reserva.
  add column if not exists valor_total numeric,
  -- El id del bloqueo REAL en LobbyPMS (POST /block -> blocked_ids[0]) — null si no se pudo
  -- crear (API oficial caída, IP no autorizada, categoría sin resolver).
  add column if not exists lobby_block_id integer,
  -- El category_id de LobbyPMS usado para el bloqueo — se reutiliza tal cual al crear la
  -- reserva real, para no volver a resolverlo y arriesgarse a que salga distinto.
  add column if not exists lobby_category_id integer,
  -- Una vez el equipo confirma el pago (/confirmar) y se crea la reserva real: el booking_id y
  -- el room_id que devolvió LobbyPMS. Solo trazabilidad — no cambia `estado`.
  add column if not exists lobby_booking_id integer,
  add column if not exists lobby_room_id integer;

select 'bloqueos_temporales (con columnas de LobbyPMS)' as tabla, count(*) from bloqueos_temporales;
