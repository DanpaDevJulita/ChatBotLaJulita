-- ============================================================
-- Glamping La Julita - Chatbot
-- POLÍTICA: pagar en el sitio (ticket #15 del panel)
-- ============================================================
-- [2026-09-18] De dónde sale: Sebas lo reportó por audio después de una conversación real en la
-- que un cliente preguntó "la verdad sí me interesa, ¿puedo llegar a pagar en el sitio?" y el bot
-- no tuvo con qué responder — derivó al equipo, y esa derivación abrió sola el ticket #14.
--
-- Lo que dictó Sebas: "debe explicar que sí puede pagar en el sitio, pero mínimo un día antes o
-- dos días antes de la reserva, que no sea un festivo o un fin de semana. Confirmar bien con
-- Stephanie cómo debería ser ese pago. Pero lo que sí no se puede es pagar el mismo día la
-- reserva. Tiene que pagar con anterioridad."
--
-- ⚠️ PENDIENTE DE CONFIRMAR CON STEPHANIE. Daniel pidió cargarlo igual para que el bot deje de
-- quedarse mudo, así que el texto de abajo toma la versión MÁS PRUDENTE de lo que dijo Sebas:
-- "al menos un día antes" (él dijo "uno o dos", y prometer uno cuando son dos es peor que al
-- revés). Cuando Stephanie confirme, se edita desde el panel — no hace falta tocar código ni
-- desplegar nada, porque el bot lee esta fila con 30 segundos de cache.
--
-- Va en `politicas` como las demás, y sale LITERAL: es una condición comercial, no material para
-- que el modelo redacte (ver herramientas/politicas.ts, tema='pago_en_sitio').
--
-- Se puede correr varias veces sin romper nada: es un UPSERT.
-- ============================================================

INSERT INTO politicas (clave, titulo, contenido, activo) VALUES
(
  'pago_en_sitio',
  'Pago en el sitio (ticket #15 — pendiente de confirmar con Stephanie)',
  E'💵 *Pagar en el glamping*\n\n'
  E'Sí se puede, pero con anticipación: el pago se recibe en el sitio *al menos un día antes* de la fecha de tu reserva, y ese día no puede ser fin de semana ni festivo.\n\n'
  E'Lo que no podemos recibir es el pago el mismo día de la estadía 🙏 Para apartar la fecha necesitamos el pago por adelantado.\n\n'
  E'Si te queda más fácil, también puedes apartar desde donde estés con el abono del 50% por el link que te envío por aquí ✨',
  true
)
ON CONFLICT (clave) DO UPDATE
  SET titulo = EXCLUDED.titulo,
      contenido = EXCLUDED.contenido,
      activo = EXCLUDED.activo,
      updated_at = now();

-- Verificación: una fila, activa.
SELECT clave, activo, contenido FROM politicas WHERE clave = 'pago_en_sitio';
