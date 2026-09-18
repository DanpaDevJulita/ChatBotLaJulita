-- ============================================================
-- Glamping La Julita - Chatbot
-- SALUDO DE BIENVENIDA: el primer mensaje de toda conversación nueva
-- ============================================================
-- [2026-09-18] Contexto: Daniel probó el bot desde cero (`/reset`, y después "info"), y el primer
-- mensaje que recibió fue la explicación de que el valor varía según la fecha — nunca el saludo
-- con el aviso de la política de datos. Su reclamo: "¿por qué no envió mensaje de políticas? Eso
-- es súper importante, y debe ser el primer mensaje".
--
-- La causa: el saludo era una INSTRUCCIÓN DEL PROMPT, o sea algo que el modelo decidía. Cuando
-- una herramienta devuelve texto literal (por ejemplo `presentar_glamping` ante un "info"), ese
-- texto es el mensaje del turno y el saludo no sale nunca.
--
-- Ahora lo manda el pipeline: si la conversación no tiene ningún mensaje previo, este texto sale
-- primero y recién después se atiende lo que el cliente escribió (ver saludarSiEsElPrimerMensaje
-- en src/core/pipeline/runTurn.ts).
--
-- Vive en `politicas` para que el equipo lo edite desde el panel sin tocar código. OJO: el código
-- tiene una copia de respaldo (SALUDO_RESPALDO en runTurn.ts) por si la base no responde — es la
-- única excepción a la regla de "un texto, un solo lugar", porque quedarse sin el aviso legal es
-- peor que mandar una versión de hace un rato. Si se cambia este texto, hay que cambiar esa copia.
--
-- El link va a la política EXACTA, no a la portada del sitio: el aviso promete una política que
-- el cliente tiene que poder leer.
--
-- Se puede correr varias veces sin romper nada: es un UPSERT.
-- ============================================================

INSERT INTO politicas (clave, titulo, contenido, activo) VALUES
(
  'saludo_bienvenida',
  'Saludo de bienvenida (primer mensaje, con el aviso de datos)',
  E'✨ ¡Hola! Soy Estefany de La Julita Glamping 🌿🏕️ Me encantaría ayudarte a elegir el plan perfecto.\n'
  E'📌 Al continuar aceptas nuestra política de datos 👉 https://lajulitaglamping.com.co/politica-de-privacidad/\n'
  E'Cuéntame 👇 ¿vienen en pareja, en familia o con amigas? 📆 ¿y para qué fecha?',
  true
)
ON CONFLICT (clave) DO UPDATE
  SET titulo = EXCLUDED.titulo,
      contenido = EXCLUDED.contenido,
      activo = EXCLUDED.activo,
      updated_at = now();

-- Verificación: una fila, con el link a /politica-de-privacidad/.
SELECT clave, activo, contenido FROM politicas WHERE clave = 'saludo_bienvenida';
