-- ============================================================
-- Glamping La Julita - Chatbot
-- Bucket público de Supabase Storage para las FOTOS de las promociones
-- ============================================================
-- [2026-09-15] Mismo patrón que sql/planes-videos-bucket.sql, pero para las fotos de las
-- tarjetas del carrusel de promociones. WhatsApp necesita una URL pública (sin login) para
-- poder descargar la imagen de cada tarjeta.
--
-- Desde el panel de Supabase: Storage → promociones-imagenes → Upload file. Al subir, Supabase
-- da una URL pública fija de la forma:
--   https://<tu-proyecto>.supabase.co/storage/v1/object/public/promociones-imagenes/<archivo>.jpg
-- Esa URL es la que se pega en el campo "imagen_url" de la promoción, desde el panel admin.
--
-- Recomendaciones para las fotos:
--   - Formato JPG o PNG.
--   - Horizontal / panorámica — WhatsApp recorta a formato ancho en la tarjeta.
--   - Sin límite estricto de WhatsApp como el de video (16 MB), pero conviene subir algo
--     liviano (menos de 2-3 MB) para que la tarjeta cargue rápido en el celular del cliente.
--
-- Se puede correr varias veces sin romper nada (el bucket no se duplica ni se borra si ya existe).
-- ============================================================

insert into storage.buckets (id, name, public)
values ('promociones-imagenes', 'promociones-imagenes', true)
on conflict (id) do update set public = true;

drop policy if exists "promociones-imagenes: lectura pública" on storage.objects;
create policy "promociones-imagenes: lectura pública"
  on storage.objects for select
  using (bucket_id = 'promociones-imagenes');

-- ============================================================
-- Verificación:
--   select id, name, public from storage.buckets where id = 'promociones-imagenes';
--   select name, bucket_id from storage.objects where bucket_id = 'promociones-imagenes';
-- ============================================================
