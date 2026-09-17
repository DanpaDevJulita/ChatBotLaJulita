-- ============================================================
-- Glamping La Julita - Chatbot
-- PLANES: actualiza el comentario de link_video (ahora es un archivo, no un link de YouTube)
-- ============================================================
-- [2026-09-16] Sigue a sql/planes-link-video.sql y sql/planes-videos-bucket.sql. La columna
-- `planes.link_video` YA EXISTE (no se toca su tipo ni sus datos) — esto solo actualiza el
-- comentario para que quede claro, en la base misma, que lo que se espera ahí ahora es la URL
-- DIRECTA de un archivo .mp4 (por ejemplo del bucket "planes-videos", ver
-- sql/planes-videos-bucket.sql) y no un link a la página de YouTube. El código (ver
-- src/agentes/ventas/herramientas/planes.ts) sigue aceptando un link de YouTube como antes —
-- cae al modo de texto con preview en vez de video nativo — mientras el equipo termina de subir
-- el .mp4 real de cada plan.
--
-- Se puede correr varias veces sin romper nada.
-- ============================================================

comment on column planes.link_video is
  'Video de este plan. Preferido: URL directa de un archivo .mp4 público (ej. bucket "planes-videos" de Supabase Storage) — se manda como video NATIVO de WhatsApp, con miniatura y reproducción sin salir de la app. También acepta (modo viejo, menos bueno) un link de YouTube: se manda como texto con preview. NULL = sin video cargado, el bot no lo menciona.';

-- ============================================================
-- Verificación:
-- select id, nombre, link_video from planes order by id;
-- ============================================================
