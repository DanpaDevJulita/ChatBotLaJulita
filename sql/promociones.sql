-- ============================================================
-- Glamping La Julita - Chatbot
-- MÓDULO DE PROMOCIONES: carrusel de WhatsApp estilo Movistar
-- ============================================================
-- [2026-09-15] Pedido de Daniel: reservar el carrusel de WhatsApp (ver
-- REFERENCIA-CAROUSEL-WHATSAPP.md) SOLO para promociones, que el equipo dispara a mano desde el
-- panel de administración cuando lanzan una oferta — no es contenido que el bot mande solo
-- durante una conversación normal.
--
-- Por qué dos tablas y no una:
--   - `promociones`: el contenido (foto, texto, botón) de cada oferta. Es contenido PROPIO, no
--     depende de que exista un plan cargado en `planes` (puede ser un combo, un 2x1, un paquete
--     que no es ninguno de los planes normales).
--   - `plantillas_carousel`: WhatsApp aprueba una plantilla con un número FIJO de tarjetas (2 a
--     10) — no se puede mandar "las que estén activas hoy" si ese número no calza exacto con lo
--     que Meta aprobó. Esta tabla es el registro de qué plantillas ya están aprobadas y para
--     cuántas tarjetas sirve cada una, para que el código (y el panel) puedan validar ANTES de
--     mandar nada, en vez de que YCloud rechace el envío a mitad de camino.
-- ============================================================

create table if not exists promociones (
  id serial primary key,
  nombre text not null,
  -- Texto que va DENTRO de la tarjeta del carrusel (no el mensaje completo). WhatsApp limita el
  -- body de cada tarjeta a ~160 caracteres — mucho más corto que el detalle que hoy manda
  -- consultarPlanesTool para un plan. Ejemplo: "🎉 2x1 en Plan Confort · válido hasta el 30 de sep".
  texto_tarjeta text not null,
  -- URL pública de la foto de la tarjeta (bucket "promociones-imagenes", ver
  -- sql/promociones-imagenes-bucket.sql — mismo patrón que planes-videos-bucket.sql).
  imagen_url text not null,
  -- Botón de la tarjeta. `boton_url` es OPCIONAL: si la plantilla registrada no trae botón de
  -- link (ver `plantillas_carousel.incluye_boton_url`), este campo no se usa.
  boton_texto text not null default 'Quiero esta promo',
  boton_url text,
  -- Orden de aparición en el carrusel (de menor a mayor). Con empates, se ordena por id.
  orden integer not null default 0,
  -- Solo las promociones "activa" entran al carrusel cuando el equipo dispara una campaña.
  activa boolean not null default true,
  creado_en timestamptz not null default now()
);

comment on table promociones is
  'Ofertas/promociones que el equipo muestra por WhatsApp con el carrusel estilo Movistar. '
  'Contenido propio (no depende de la tabla planes) — ver REFERENCIA-MODULO-PROMOCIONES.md.';

-- Qué plantillas de WhatsApp ya están aprobadas por Meta (vía YCloud) y para cuántas tarjetas
-- sirve cada una. El equipo la llena a mano DESPUÉS de crear y aprobar la plantilla en YCloud
-- (ver REFERENCIA-CAROUSEL-WHATSAPP.md, sección 4) — este registro es lo que el código usa para
-- saber qué plantilla mandar según cuántas promociones estén activas hoy.
create table if not exists plantillas_carousel (
  id serial primary key,
  nombre_plantilla text not null unique,
  idioma text not null default 'es',
  -- Tiene que ser EXACTAMENTE el número de tarjetas con el que se aprobó en Meta/YCloud.
  cantidad_tarjetas integer not null check (cantidad_tarjetas between 2 and 10),
  -- Si la plantilla se aprobó con un botón de tipo URL en cada tarjeta (además del de
  -- respuesta rápida), esto tiene que ser true — el código exige `boton_url` en cada promoción
  -- que se vaya a enviar con esta plantilla. Si la plantilla solo trae respuesta rápida, false.
  incluye_boton_url boolean not null default true,
  activa boolean not null default true,
  creado_en timestamptz not null default now()
);

comment on table plantillas_carousel is
  'Registro de qué carousel templates de WhatsApp ya aprobó Meta y para cuántas tarjetas sirve '
  'cada uno. Se llena a mano desde el panel después de aprobar la plantilla — el código nunca '
  'crea plantillas solo, eso siempre pasa por YCloud + revisión de Meta.';

-- Historial de campañas disparadas — para saber qué se mandó, a cuántos, y qué falló, sin tener
-- que ir a buscar en los logs del servidor. Mismo espíritu que alertas_tecnicas.sql: que quede
-- registro de lo que pasó en el negocio, no solo en la consola.
create table if not exists promociones_envios (
  id serial primary key,
  plantilla_nombre text not null,
  promocion_ids integer[] not null,
  total_destinatarios integer not null,
  total_exitosos integer not null default 0,
  total_fallidos integer not null default 0,
  -- [{"destinatario": "+573...", "error": "..."}] — solo los que fallaron, para poder
  -- reintentarles sin tener que volver a mandarle a todo el mundo.
  detalle_fallidos jsonb not null default '[]'::jsonb,
  creado_en timestamptz not null default now()
);

comment on table promociones_envios is
  'Historial de campañas de promociones disparadas desde el panel — qué plantilla, cuántos '
  'destinatarios, cuántos fallaron y por qué. Ver enviarPromocionesCarousel() en '
  'src/core/marketing/promocionesBroadcast.ts.';

-- ============================================================
-- Verificación:
--   select id, nombre, activa, orden from promociones order by orden, id;
--   select nombre_plantilla, cantidad_tarjetas, incluye_boton_url, activa from plantillas_carousel;
--   select id, plantilla_nombre, total_destinatarios, total_exitosos, total_fallidos, creado_en
--     from promociones_envios order by creado_en desc limit 20;
-- ============================================================
