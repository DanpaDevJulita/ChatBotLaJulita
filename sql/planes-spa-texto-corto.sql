-- ============================================================
-- Glamping La Julita - Chatbot
-- PLANES: acorta el texto de spa en la descripción (ids 3, 21 y 27)
-- ============================================================
-- [2026-09-17] YA APLICADO en producción. Queda acá como registro y para poder revertir.
--
-- Por qué: el detalle de un plan ahora sale SIEMPRE completo (se quitó la versión corta, ver
-- src/agentes/ventas/herramientas/planes.ts) y viaja junto con el video. Eso hace que el largo
-- del texto importe de verdad, por dos límites de WhatsApp:
--   * los mensajes largos se cortan con un "Leer más" (~700 caracteres) — y lo que queda
--     debajo del corte es justo el cupo y la pregunta de cierre, o sea lo que hace que el
--     cliente conteste;
--   * como PIE DE FOTO de un video WhatsApp acepta 1024 caracteres. Si el texto no cabe, el
--     video y el texto van en dos mensajes separados y pueden llegar en cualquier orden.
--
-- Midiendo los 20 planes reales, el párrafo de spa era el bloque más pesado: ~450 caracteres,
-- repetido casi igual en 3 planes. Acá se reemplaza por una línea con LOS MISMOS DATOS (los 30
-- minutos por persona, las zonas del masaje, la exfoliación, el hidromasaje, la quebrada, el
-- jacuzzi, el turco, la aromaterapia y la musicoterapia). Lo que se quitó es el relato de venta
-- ("Sumérgete en nuestro...", "un circuito que combina relajación y revitalización"), que en un
-- mensaje de WhatsApp juega en contra. La descripción larga del spa sigue disponible por
-- `consultar_adicionales`, que es donde el spa vive como servicio.
--
-- Resultado medido sobre los 20 planes (junto con la compactación de horarios y nota del chalet
-- que hace el código): de 17/20 a 18/20 en un solo mensaje, de 12/20 a 13/20 sin "Leer más",
-- y el promedio bajó de 803 a 709 caracteres.
--
-- OJO con el patrón: el plan 21 tenía un espacio de más después de "Spa básico:", así que la
-- primera versión de este UPDATE no lo tocó. Por eso el patrón usa `.` en vez del texto exacto.
-- ============================================================

update planes
set descripcion = regexp_replace(
  descripcion,
  'Spa b.sico:.*?musicoterapia',
  'Spa básico en pareja: masaje de 30 min a cada uno (espalda, cuello, brazos y piernas), exfoliación corporal, hidromasaje de agua caliente, aromaterapia y musicoterapia'
)
where id in (3, 21);

update planes
set descripcion = regexp_replace(
  descripcion,
  'Spa premium:.*?musicoterapia',
  'Spa premium en pareja: masaje de 30 min a cada uno (espalda, cuello, brazos y piernas), exfoliación corporal e hidromasaje de agua caliente; después inmersión en la quebrada fría, jacuzzi termorregulado y turco selvático 30 min, con aromaterapia y musicoterapia'
)
where id = 27;

-- ============================================================
-- Verificación:
-- select id, length(descripcion) from planes where id in (3,21,27) order by id;
--   -> 3: 797 · 21: 1100 · 27: 1085 caracteres
-- select id from planes where descripcion ilike '%Disfruta de nuestro%';  -> 0 filas
-- ============================================================

-- ============================================================
-- PARA REVERTIR (textos originales, tal como estaban antes del 17/09/2026):
--
-- update planes set descripcion = regexp_replace(descripcion, 'Spa básico en pareja:.*?musicoterapia',
--   'Spa básico: Disfruta de nuestro Spa básico: un circuito en pareja que combina relajación y '
--   'revitalización. Mientras uno de ustedes recibe un masaje individual de 30 minutos en la parte '
--   'posterior de la espalda, cuello, brazos y piernas, el otro disfruta de una exfoliación corporal '
--   'seguida de un hidromasaje con chorros de agua caliente. Luego cambian de camilla por otros 30 '
--   'minutos. Esta experiencia se complementa con aromaterapia, musicoterapia')
-- where id in (3, 21);
--
-- update planes set descripcion = regexp_replace(descripcion, 'Spa premium en pareja:.*?musicoterapia',
--   'Spa premium: Sumérgete en nuestro Spa premium para parejas: Mientras uno disfruta de un masaje '
--   'de 30 minutos en espalda, cuello, brazos y piernas, el otro recibe una exfoliación corporal '
--   'seguida de un hidromasaje con chorros de agua caliente, cambian de camilla por otros 30 minutos. '
--   'Luego, ambos se sumergen en nuestra quebrada de agua fría, pasan al jacuzzi termorregulado y '
--   'terminan la experiencia en nuestro turco selvático por 30 minutos. Esta experiencia se '
--   'complementa con aromaterapia, musicoterapia')
-- where id = 27;
-- ============================================================

-- ============================================================
-- PENDIENTES que quedaron medidos y NO se aplicaron:
--
-- 1. "Fogata" aparece DOS VECES en los planes 24, 25, 26, 34, 37 y 38 — el cliente ve el ítem
--    repetido. Se arregla editando esas descripciones en el panel (o quitando duplicados en
--    código). Ahorro ~35 caracteres, y sobre todo se ve más prolijo.
--
-- 2. Los planes CLASICO VIP (21) y PARAISO (27) siguen saliendo en DOS mensajes (~1198 y ~1248
--    caracteres): tienen más de 20 ítems. Para que entren en uno solo habría que acortar la
--    línea de "Decoración premium" y la de "Elige una entrada", que ocupan ~200 entre las dos.
--
-- 3. Ordenar los ítems poniendo primero lo que más vende (spa, cena, decoración, coctelería) y
--    al final lo básico (parqueadero, ventilador, minibar): no ahorra caracteres, pero cambia
--    lo que el cliente alcanza a leer antes del "Leer más".
-- ============================================================
