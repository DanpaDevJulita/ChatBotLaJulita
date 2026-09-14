-- ============================================================
-- Glamping La Julita - Chatbot
-- Tabla `politicas`: los textos oficiales que el bot le muestra al cliente
-- ============================================================
-- [2026-09-13] Contexto: hasta hoy el bot no tenía las políticas del glamping. Decía "según las
-- condiciones del plan" y en los prompts estaba escrito que la política de cancelación "todavía
-- no está definida". Daniel pasó las dos piezas oficiales (TÉRMINOS Y CONDICIONES DE TU RESERVA
-- e Información importante antes de reservar) y pidió que vivan en la base, para poder
-- cambiarlas sin tocar código.
--
-- POR QUÉ EN UNA TABLA Y NO EN EL PROMPT
-- -------------------------------------
-- Estos textos traen cifras ($ 100.000 por cambiar la fecha, $ 40.000 la hora extra...). El
-- pipeline descarta cualquier mensaje del bot con una cifra de dinero que no haya salido de una
-- herramienta (ver `montosEn` en src/core/pipeline/runTurn.ts). Si las políticas vivieran en el
-- prompt, el modelo las parafrasearía —cambiando plazos y montos— y encima el mensaje se
-- caería. Saliendo de acá, el texto llega al cliente EXACTO.
--
-- Es el mismo molde de la tabla `faq`: clave de texto + contenido, con cache de 30s del lado
-- del bot (ver src/core/db/politicasRepo.ts) y edición desde el panel de administración.
--
-- Se puede correr varias veces sin romper nada: crea si no existe, y el seed hace UPSERT.
-- ============================================================

CREATE TABLE IF NOT EXISTS politicas (
  clave       text PRIMARY KEY,
  titulo      text,
  contenido   text NOT NULL,
  -- Para que el equipo pueda apagar una política sin borrarla (misma convención que `planes`).
  activo      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE politicas IS
  'Textos oficiales que el bot manda TAL CUAL al cliente (terminos, condiciones, normas). El bot nunca los reformula.';
COMMENT ON COLUMN politicas.clave IS
  'Identificador que usa el codigo: terminos_reserva | antes_de_reservar | saldo_pendiente | cambios_corta';

-- ============================================================
-- SEED — el contenido oficial, tal cual las piezas del glamping
-- ============================================================
-- Se usa dollar-quoting ($pol$ ... $pol$) en vez de comillas simples para que el texto pueda
-- traer tildes, emojis, comillas y saltos de línea sin tener que escapar nada.
--
-- Formato del contenido: es WhatsApp. La negrita va con UN asterisco (*así*), nunca con dos.

-- 1) Términos y condiciones de la reserva -------------------------------------------------
INSERT INTO politicas (clave, titulo, contenido) VALUES (
  'terminos_reserva',
  'Términos y condiciones de tu reserva',
  $pol$📋 *Términos y condiciones de tu reserva*

• Una vez realizado el pago no generamos reembolsos (sin excepciones).
• Antes de realizar el pago, verifica cuidadosamente la disponibilidad de tu fecha para reservar.
• Puedes reprogramar tu fecha una vez, sin ningún valor extra, si faltan 15 días o más para el check-in (máximo 2 meses a partir de la fecha reservada).
• Si no puedes asistir a tu reserva, puedes cedérsela a un familiar o amigo en la misma fecha, avisando mínimo 24 horas antes de la llegada. Si no asistes, no se realizan reembolsos (sin excepciones).

Sabemos que se presentan imprevistos de última hora, así que tenemos estos beneficios para ti:

1. Si se presentan eventos ajenos al glamping y a ti (paros, derrumbes, cierre de vías), se cambia la fecha sin ningún valor adicional, sujeto a disponibilidad.
2. Avisando de 14 a 5 días antes de tu check-in, puedes modificar tu fecha pagando el 50% restante más un adicional de $ 100.000.
3. Avisando de 4 a 1 día antes de tu check-in, puedes modificar tu fecha pagando el 50% restante más un adicional de $ 150.000.

Todos los cambios de fecha son máximo a 2 meses a partir de la fecha reservada.

Al realizar el pago aceptas nuestras políticas y condiciones 💚$pol$
)
ON CONFLICT (clave) DO UPDATE
  SET titulo = EXCLUDED.titulo, contenido = EXCLUDED.contenido, updated_at = now();

-- 2) Información importante antes de reservar ---------------------------------------------
INSERT INTO politicas (clave, titulo, contenido) VALUES (
  'antes_de_reservar',
  'Información importante antes de reservar',
  $pol$✨ *Información importante antes de reservar*

👤 Solo admitimos mayores de edad. Los menores que vengan sin sus padres deben traer un permiso especial en formato autenticado en notaría — pregúntanos antes de reservar para que no haya sorpresas.

🕒 *Check-in*
• Sábado a jueves: desde las 3:00 p. m. hasta las 8:00 p. m.
• Viernes: desde las 3:00 p. m. hasta las 9:00 p. m. Después de las 9:00 p. m. no hacemos check-in, cerramos todos los servicios.
• Hora extra adicional: $ 40.000

🕛 *Check-out*
• A las 12:00 del mediodía. Hora extra adicional: $ 40.000
• El restaurante cierra a las 8:00 p. m.

🛁 *Jacuzzi*
Se entrega en la hora programada, con temperatura regulada a 35°, y dura alrededor de 2 horas con hidromasaje de 30 minutos. Si quieres volver a usarlo, hay que hacer limpieza, llenado (800 litros de agua) y calentamiento de nuevo: tiene un valor de $ 40.000.

🔥 *Fogata*
Está sujeta a las condiciones del clima: con vientos fuertes o lluvia es posible que no podamos encenderla. Al ser algo fuera de nuestro control, en ese caso no se realizan devoluciones de dinero.

🚫 *Restricciones*
• No se permite el ingreso de personas bajo los efectos del alcohol o de sustancias psicotrópicas, conflictivas, sin reserva previa, o que no cumplan con las normas del establecimiento.
• Estamos en un ambiente tranquilo: no se permite el ingreso de parlantes (en tu glamping vas a encontrar sonido moderado).
• No se permite gritar ni hacer escándalo. Si traes tu mascota, debes controlar los ladridos para no incomodar a los otros clientes.
• Después de las 9:00 p. m. hay restricción de volumen.
• Si no se cumplen las normas de convivencia se hace un llamado de atención escrito; en el segundo llamado se recarga a tu cuenta una penalidad de $ 200.000, y en el tercero debes retirarte de las instalaciones.
• No se permite el ingreso de comidas ni bebidas.

Somos una empresa familiar, así que nuestras instalaciones se tratan como si fueran una casa de familia. Durante tu estadía siempre está presente uno de los dueños del establecimiento, lo que garantiza una atención de calidad y respetuosa para ambas partes 💚$pol$
)
ON CONFLICT (clave) DO UPDATE
  SET titulo = EXCLUDED.titulo, contenido = EXCLUDED.contenido, updated_at = now();

-- 3) Saldo pendiente — va DENTRO del mensaje del link de pago cuando el cliente abona -------
-- Esta no viene de las piezas nuevas: es la regla que ya usaba el equipo (está en el guion de
-- ventas). Se guarda acá para que todo lo que el cliente lee sobre plazos salga del mismo lugar.
INSERT INTO politicas (clave, titulo, contenido) VALUES (
  'saldo_pendiente',
  'Cuándo se paga el 50% restante',
  $pol$🗓️ Si tu llegada es viernes, sábado, domingo de puente festivo o pasadía, el saldo se paga un día antes del check-in. De domingo a jueves, se paga al llegar al glamping.$pol$
)
ON CONFLICT (clave) DO UPDATE
  SET titulo = EXCLUDED.titulo, contenido = EXCLUDED.contenido, updated_at = now();

-- 4) Cambios y cancelación, versión corta — va DENTRO del mensaje del link de pago ----------
-- Es el resumen de los términos completos: lo mínimo que el cliente tiene que saber ANTES de
-- pagar. El detalle (con los adicionales de $ 100.000 / $ 150.000) se lo manda el bot con
-- `consultar_politicas` si pregunta por cambios o cancelaciones.
INSERT INTO politicas (clave, titulo, contenido) VALUES (
  'cambios_corta',
  'Cambios y cancelaciones (resumen para el mensaje de pago)',
  $pol$🔄 Puedes reprogramar tu fecha una vez, sin costo extra, si faltan 15 días o más para el check-in (máximo 2 meses a partir de la fecha reservada).
🚫 Una vez realizado el pago no generamos reembolsos, sin excepciones. Si no puedes venir, puedes cederle la reserva a un familiar o amigo avisando mínimo 24 horas antes de tu llegada.$pol$
)
ON CONFLICT (clave) DO UPDATE
  SET titulo = EXCLUDED.titulo, contenido = EXCLUDED.contenido, updated_at = now();

-- ============================================================
-- Verificación (debe devolver las 4 filas con su tamaño de texto):
-- SELECT clave, titulo, length(contenido) AS caracteres, activo, updated_at
--   FROM politicas ORDER BY clave;
-- ============================================================
