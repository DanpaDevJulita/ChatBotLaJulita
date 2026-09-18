-- ============================================================
-- Glamping La Julita - Chatbot
-- Texto de PRESENTACIÓN: la respuesta a "solo quiero precios"
-- ============================================================
-- [2026-09-17] Contexto: probando con un vendedor, un cliente escribió "Solo quiero precios" sin
-- decir fecha ni cuántas personas eran, y el bot le mandó el menú de las tres experiencias con
-- tres cifras. El vendedor pidió corregirlo: cuando alguien pregunta precios en seco hay que
-- aclararle que el valor varía según la fecha exacta, la cantidad de personas y el tipo de plan.
--
-- [2026-09-17, segunda vuelta — ticket #5 del panel] La primera versión de este texto era una
-- presentación larga que terminaba con dos "desde" (`🌿 Entre semana desde $$$$`, `✨ Fin de
-- semana desde $$$$`). Daniel la probó en vivo y pidió sacarla: le llegó "Entre semana desde
-- $ 3.000" — el precio real de un plan cargado así en la base, elegido por ser el más barato —
-- y un "desde" de $ 3.000 no dice nada bueno del glamping ni se parece a lo que el cliente va a
-- terminar pagando. El texto que pidió en su lugar es UNA frase, sin ninguna cifra:
--
--     corrige para este caso ya no envies este mensaje "✨🌿Somos la Julita Glamping ..."
--     mejor enviamos este, "💫 El valor de tu experiencia varía según la fecha exacta de tu
--     visita 📅, las personas que te acompañen 👥 y el plan que disfrutes 🌿🥂 (descanso o
--     celebración en fechas especiales)."
--
-- Va tal cual, sin agregarle una pregunta por la fecha y las personas: Daniel lo confirmó así.
-- El dato que falta lo pide el bot en su propio mensaje, con su voz, en el turno siguiente.
--
-- Se guarda en la tabla `politicas` (que ya existe, ya tiene cache de 30s y ya se edita desde el
-- panel) en vez de crear una tabla nueva para una sola fila. `consultar_politicas` NO la devuelve:
-- esa herramienta solo mapea sus temas a las 4 claves de condiciones comerciales.
--
-- SOBRE LOS PRECIOS: hoy este texto no lleva ninguno, y es lo que se quiere. Si algún día el
-- equipo vuelve a poner una cifra acá, va como `$$$$` — el mismo token que usan las descripciones
-- de los planes — y `presentar_glamping` lo reemplaza en vivo por la NOCHE MÁS ECONÓMICA cargada,
-- decidiendo cuál de las dos tarifas según lo que diga esa misma línea. Un precio escrito a mano
-- es el bug del 2026-09-11: el equipo cambia la tarifa en `planes` y esta copia queda vieja,
-- prometiéndole al cliente un valor que ya no existe. Ver REGLA-DESCRIPCIONES-PRECIOS.md.
--
-- Se puede correr varias veces sin romper nada: es un UPSERT.
-- ============================================================

INSERT INTO politicas (clave, titulo, contenido, activo) VALUES
(
  'presentacion_general',
  'Presentación del glamping (respuesta a "solo quiero precios")',
  E'💫 El valor de tu experiencia varía según la fecha exacta de tu visita 📅, las personas que te acompañen 👥 y el plan que disfrutes 🌿🥂 (descanso o celebración en fechas especiales).',
  true
)
ON CONFLICT (clave) DO UPDATE
  SET titulo = EXCLUDED.titulo,
      contenido = EXCLUDED.contenido,
      activo = EXCLUDED.activo,
      updated_at = now();

-- Verificación: tiene que devolver una fila, con la frase y sin ninguna cifra.
SELECT clave, activo, contenido FROM politicas WHERE clave = 'presentacion_general';
