-- ============================================================
-- Glamping La Julita - Chatbot
-- PLANES: link de YouTube con el video del plan
-- ============================================================
-- [2026-09-14] Pedido de Daniel: cuando el cliente pide más información de un plan, además del
-- texto que ya manda `consultar_planes` (detalle completo, ver src/agentes/ventas/herramientas/
-- planes.ts), agregar el link de YouTube donde está la misma información pero en video.
--
-- Se guarda por PLAN (no un link único general) porque cada plan tiene su propio video — así
-- el equipo lo carga desde el panel de administración, uno por uno, sin tocar código.
--
-- NULL = ese plan todavía no tiene video cargado: el bot simplemente no menciona ninguno (nunca
-- inventa un link). Se puede correr varias veces sin romper nada.
-- ============================================================

alter table planes add column if not exists link_video text;

comment on column planes.link_video is
  'Link de YouTube con el video de este plan (misma información que la descripción, en video). NULL = sin video cargado, el bot no lo menciona.';

-- ============================================================
-- PLACEHOLDER TEMPORAL (pedido de Daniel, 2026-09-14 tarde)
-- ============================================================
-- Mientras el equipo pasa el video real de CADA plan, se deja este mismo link en TODOS los
-- planes que todavía no tengan uno cargado — así el mensaje ya sale con algo en vez de nada.
-- Solo llena los que están en NULL: si un plan ya tiene su video real cargado, esto no lo pisa.
-- Cuando llegue el video real de un plan, se reemplaza con un UPDATE puntual (o desde el panel
-- de administración) — no hace falta volver a correr este archivo.
update planes
set link_video = 'https://youtube.com/shorts/nFfx614CI-Y?si=szTnkKOn_QHx5Qhz'
where link_video is null;

-- ============================================================
-- Verificación:
-- select id, nombre, link_video from planes order by id;
-- ============================================================
