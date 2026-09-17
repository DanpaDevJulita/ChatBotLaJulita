-- ============================================================
-- Glamping La Julita - Chatbot
-- PLANES: SKU del catálogo de WhatsApp (Meta Commerce Manager)
-- ============================================================
-- [2026-09-15] Pedido de Daniel: mostrar los planes "bonito" (con foto, deslizable) SIN pagar
-- el costo de mensaje de Marketing — a diferencia del carrusel (que WhatsApp obliga a que sea
-- siempre una plantilla de Marketing, sin excepción), el mensaje de CATÁLOGO
-- (`interactive.type: "product_list"`) es un mensaje normal (gratis dentro de la conversación),
-- pero exige que cada plan exista como "producto" en un catálogo de Meta conectado a la cuenta
-- de WhatsApp. Ver REFERENCIA-CATALOGO-WHATSAPP.md para el paso a paso completo (crear el
-- catálogo en Meta Commerce Manager, conectarlo al WABA, y cargar cada plan como producto).
--
-- `retailer_id` es el identificador (SKU) que le pusiste a ESE plan al cargarlo en el catálogo
-- de Meta — el bot lo necesita para decirle a WhatsApp "muéstrame este producto del catálogo".
-- NULL = ese plan todavía no está cargado en el catálogo: el bot simplemente no lo incluye en
-- el mensaje de catálogo (nunca inventa un SKU).
-- ============================================================

alter table planes add column if not exists retailer_id text;

comment on column planes.retailer_id is
  'SKU (retailer_id) de este plan en el catálogo de Meta conectado al WhatsApp Business Account. '
  'NULL = sin cargar en el catálogo todavía, el bot no lo incluye en el mensaje de catálogo.';

-- ============================================================
-- Verificación:
--   select id, nombre, retailer_id from planes order by id;
-- ============================================================
