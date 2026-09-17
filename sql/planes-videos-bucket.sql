-- ============================================================
-- Glamping La Julita - Chatbot
-- Bucket público de Supabase Storage para los VIDEOS de los planes
-- ============================================================
-- [2026-09-16] Pedido de Daniel: que el video del plan se vea con miniatura en WhatsApp y se
-- reproduzca SIN salir de la app. Un link de YouTube pegado en el texto no puede cumplir eso
-- (WhatsApp no reproduce adentro videos de otras plataformas, solo archivos de video reales) —
-- ver la investigación completa en el chat. La solución es mandar el video como mensaje NATIVO
-- de WhatsApp (`type: "video"`), y para eso hace falta una URL pública que apunte DIRECTO a un
-- archivo .mp4 — no a una página como youtube.com/watch.
--
-- Este script crea un bucket público llamado "planes-videos" en Supabase Storage donde el
-- equipo puede subir el .mp4 de cada plan (desde el panel de Supabase: Storage → planes-videos
-- → Upload file). Al subir un archivo, Supabase le da una URL pública fija, de la forma:
--
--   https://<tu-proyecto>.supabase.co/storage/v1/object/public/planes-videos/<nombre-archivo>.mp4
--
-- Esa URL es la que se pega en el campo "link_video" del plan, en el panel de administración
-- del bot (ver src/web/admin/routes.ts) — igual que antes se pegaba el link de YouTube, pero
-- ahora esta URL sí sirve para mandar el video nativo.
--
-- Recomendaciones para los archivos que suban:
--   - Formato .mp4 (H.264) — es el que WhatsApp reproduce mejor.
--   - Máximo 16 MB por video (límite de WhatsApp) — si el archivo pesa más, hay que comprimirlo
--     o acortarlo antes de subirlo.
--
-- Se puede correr varias veces sin romper nada (el bucket no se duplica ni se borra si ya
-- existe).
-- ============================================================

-- El bucket en sí: "public = true" es lo que habilita la URL pública de solo lectura, sin
-- necesitar login ni token — así WhatsApp (YCloud) puede descargar el archivo para reenviarlo.
insert into storage.buckets (id, name, public)
values ('planes-videos', 'planes-videos', true)
on conflict (id) do update set public = true;

-- Política explícita de lectura pública sobre los objetos de ESTE bucket únicamente (además de
-- lo que ya habilita el bucket público, esto deja la regla clara y explícita a nivel de RLS).
-- A propósito NO se agrega ninguna política de escritura (insert/update/delete) para el rol
-- público: subir o borrar videos se sigue haciendo desde el panel de Supabase (autenticado como
-- dueño del proyecto) o con la service key del backend — nunca de forma anónima.
drop policy if exists "planes-videos: lectura pública" on storage.objects;
create policy "planes-videos: lectura pública"
  on storage.objects for select
  using (bucket_id = 'planes-videos');

-- ============================================================
-- Verificación:
--   select id, name, public from storage.buckets where id = 'planes-videos';
--   select name, bucket_id from storage.objects where bucket_id = 'planes-videos';
-- ============================================================
