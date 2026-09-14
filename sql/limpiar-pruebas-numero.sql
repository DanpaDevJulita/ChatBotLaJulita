-- ============================================================
-- Glamping La Julita - Chatbot
-- BORRAR los datos de prueba de UN número, para volver a probar "desde ceros"
-- ============================================================
-- [2026-09-13] Pedido de Daniel: dejar su propio número (3212191805) como si nunca hubiera
-- escrito — sin conversación, sin reserva, sin pagos — para probar el camino feliz limpio.
--
-- ⚠️ ESTO BORRA DE VERDAD Y NO SE PUEDE DESHACER. Por eso está escrito para correrse en dos
-- pasos: primero MIRAR qué se va a borrar (PASO 1) y solo después borrarlo (PASO 2).
--
-- El número se pone UNA sola vez, acá abajo. Se compara con LIKE porque el mismo número queda
-- guardado en formatos distintos según la tabla: en `clientes.celular` suele estar como
-- "3212191805" y en `mensajes.external_id` / `estado_conversacion.external_id` como
-- "+573212191805".
-- ============================================================


-- ============================================================
-- PASO 1 — MIRAR (no borra nada). Corré SOLO esto primero.
-- ============================================================
select 'clientes'            as tabla, count(*)::int as filas from clientes where celular like '%3212191805%'
union all select 'reservas',            count(*)::int from reservas r  join clientes c on c.id = r.cliente_id where c.celular like '%3212191805%'
union all select 'pagos',               count(*)::int from pagos p     join reservas r on r.id = p.reserva_id join clientes c on c.id = r.cliente_id where c.celular like '%3212191805%'
union all select 'acompanantes',        count(*)::int from acompanantes a join reservas r on r.id = a.reserva_id join clientes c on c.id = r.cliente_id where c.celular like '%3212191805%'
union all select 'mensajes',            count(*)::int from mensajes            where external_id like '%3212191805%'
union all select 'estado_conversacion', count(*)::int from estado_conversacion where external_id like '%3212191805%'
union all select 'bloqueos_temporales', count(*)::int from bloqueos_temporales where external_id like '%3212191805%';


-- ============================================================
-- PASO 2 — BORRAR. Corré esto solo cuando el PASO 1 te haya mostrado
-- exactamente lo que esperabas (y NADA de otro cliente).
-- ============================================================
-- Va todo dentro de una transacción: si algo falla en el medio, no se borra nada a medias.
-- El orden importa por las llaves foráneas: primero lo que cuelga de la reserva (pagos,
-- acompañantes), después la reserva, y al final el cliente.
begin;

  -- Pagos y acompañantes de las reservas de este número
  delete from pagos
   where reserva_id in (
     select r.id from reservas r join clientes c on c.id = r.cliente_id
      where c.celular like '%3212191805%'
   );

  delete from acompanantes
   where reserva_id in (
     select r.id from reservas r join clientes c on c.id = r.cliente_id
      where c.celular like '%3212191805%'
   );

  -- Las reservas
  delete from reservas
   where cliente_id in (select id from clientes where celular like '%3212191805%');

  -- El cliente
  delete from clientes where celular like '%3212191805%';

  -- La conversación: historial, estado del orquestador (incluye reserva_activa_id) y
  -- cualquier bloqueo de cupo que haya quedado abierto.
  delete from mensajes            where external_id like '%3212191805%';
  delete from estado_conversacion where external_id like '%3212191805%';
  delete from bloqueos_temporales where external_id like '%3212191805%';

commit;


-- ============================================================
-- PASO 3 — CONFIRMAR que quedó en ceros (volvé a correr el PASO 1:
-- todas las filas deben dar 0).
-- ============================================================
-- OJO: el bot guarda el historial reciente de cada conversación TAMBIÉN en memoria del proceso
-- (ver historyByUser en src/core/pipeline/runTurn.ts). Después de borrar acá, reiniciá el bot
-- (web + worker) para que no siga "recordando" la charla vieja desde la memoria.
-- ============================================================
