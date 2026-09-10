\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\pset pager off

-- ============================================================================================
-- PRUEBAS DEL MODULO DE PAGOS - Glamping La Julita
-- ============================================================================================
-- Requiere, en este orden: sql/schema.sql, sql/pagos-migracion-reservas.sql, sql/pagos.sql
--
-- COMO SE CORRE: con psql, NO con el editor SQL de Supabase. Este archivo usa metacomandos
-- de psql (\echo, \gset, \set) que el editor web no entiende. La cadena de conexion esta en
-- Supabase -> Project Settings -> Database -> Connection string:
--     psql "postgresql://postgres:[CLAVE]@db.[PROYECTO].supabase.co:5432/postgres" -f sql/pagos-pruebas.sql
--
-- ON_ERROR_ROLLBACK on es imprescindible: sin el, el primer test que lanza una excepcion
-- (el TEST 3) aborta la transaccion y todos los siguientes fallan con "current transaction
-- is aborted" sin llegar a probar nada.
--
-- OJO: inserta datos de prueba. Correr contra una base VACIA o una copia, nunca contra la de
-- produccion con reservas reales.
--
-- ON_ERROR_STOP esta en off a proposito: varios tests esperan que la funcion LANCE una
-- excepcion. Si el script se detuviera en la primera, no se verian los demas.
--
-- Todo va dentro de una transaccion que se revierte al final (ROLLBACK), asi que la base
-- queda como estaba. Para dejar los datos, cambiar el ROLLBACK del final por COMMIT.
-- ============================================================================================

begin;

\echo '=========================================='
\echo 'SETUP: datos de prueba'
\echo '=========================================='

-- Catalogos minimos
insert into tipo_documento (nombre, seudonimo) values ('Cedula de ciudadania', 'CC')
  on conflict (nombre) do nothing;
insert into clase_domo (nombre) values ('Domo estandar') on conflict (nombre) do nothing;
insert into tipo_adicional (nombre) values ('Decoracion'), ('Alimentacion')
  on conflict (nombre) do nothing;

-- Cliente
insert into clientes (nombre, tipo_documento_id, numero_documento, celular, correo)
values ('Ana Perez',
        (select id from tipo_documento where seudonimo = 'CC'),
        '1020304050', '+573001112233', 'ana@test.co');

-- Dos domos y un plan que los admite
insert into domos (clase, opcion, capacidad_max) values
  ((select id from clase_domo where nombre = 'Domo estandar'), 'pareja', 2),
  ((select id from clase_domo where nombre = 'Domo estandar'), 'familia', 4);

insert into planes (nombre, descripcion, precio_entre_semana, precio_fin_de_semana, capacidad, domos_id)
values ('Romantico', 'Plan de prueba', 350000, 420000, 2,
        array(select id from domos order by id));

-- Adicionales con precio
insert into adicionales (nombre, descripcion, precio, tipo_adicional_id) values
  ('Decoracion romantica', 'Prueba', 90000, (select id from tipo_adicional where nombre = 'Decoracion')),
  ('Cena especial',        'Prueba', 150000, (select id from tipo_adicional where nombre = 'Alimentacion'));

-- Reserva: 2 noches (10 al 12 de octubre) en el primer domo. total = 700.000 de alojamiento
insert into reservas (cliente_id, domo_id, plan_id, fecha_reservada, fecha_fin_reserva,
                      numero_huespedes, valor_total, total, saldo, estado_id, expira_at)
values ((select id from clientes where numero_documento = '1020304050'),
        (select min(id) from domos),
        (select id from planes where nombre = 'Romantico'),
        '2026-10-10', '2026-10-12', 2, 700000, 700000, 700000,
        fn_estado_id('borrador'), now() + interval '4 hours');

-- Adicionales pedidos: decoracion + cena = 240.000
insert into adicionales_reserva (reserva_id, adicionales_id, cantidad, precio_unitario)
select (select max(id) from reservas), a.id, 1, a.precio
  from adicionales a
 where a.nombre in ('Decoracion romantica', 'Cena especial');

-- Id de la reserva bajo prueba, para no repetirlo en cada consulta (queda en :r1)
select max(id) as r1 from reservas \gset


\echo ''
\echo 'TEST 1 - El total suma alojamiento + adicionales (esperado: 940000)'
select fn_total_reserva(:r1) as total,
       case when fn_total_reserva(:r1) = 940000 then 'PASS' else 'FAIL' end as resultado;

\echo ''
\echo 'TEST 2 - Saldo inicial = total, pagado = 0'
select fn_pagado_reserva(:r1) as pagado, fn_saldo_reserva(:r1) as saldo,
       case when fn_pagado_reserva(:r1) = 0 and fn_saldo_reserva(:r1) = 940000
            then 'PASS' else 'FAIL' end as resultado;

\echo ''
\echo 'TEST 3 - Rechaza un abono mayor al saldo (esperado: EXCEPTION)'
select fn_crear_pago_pendiente(:r1, 2000000, 'abono', 'res-abono-999');

\echo ''
\echo 'TEST 4 - Rechaza monto cero o negativo (esperado: EXCEPTION)'
select fn_crear_pago_pendiente(:r1, 0, 'abono', 'res-abono-998');

\echo ''
\echo 'TEST 5 - Crea un abono valido de 300000'
select fn_crear_pago_pendiente(:r1, 300000, 'abono', 'res-abono-1001') as id_pago;

\echo ''
\echo 'TEST 6 - Bloquea un SEGUNDO link pendiente del mismo tipo (esperado: EXCEPTION)'
select fn_crear_pago_pendiente(:r1, 100000, 'abono', 'res-abono-1002');

\echo ''
\echo 'TEST 7 - PAR DE LINKS: uno total y uno abono conviven en la misma reserva'
select fn_crear_pago_pendiente(:r1, 640000, 'total', 'res-total-1003') as link_total;

\echo ''
\echo 'TEST 8 - Aprueba el abono de 300000 (lo que hace el webhook de Bold)'
select o_ya_procesado, o_total_reserva, o_total_pagado, o_saldo_pendiente,
       o_estado_pago, o_estado_reserva
from fn_registrar_pago_aprobado('res-abono-1001', 'BOLD-PAY-AAA', 300000, 'COMP-001', 'CUS-123');

\echo ''
\echo 'TEST 9 - La reserva quedo confirmada, con anticipo 300000 y saldo 640000'
select e.descripcion as estado_reserva, r.estado_pago, r.anticipo, r.saldo,
       case when e.descripcion ilike '%confirmad%' and r.estado_pago = 'con_anticipo'
                 and r.anticipo = 300000 and r.saldo = 640000
            then 'PASS' else 'FAIL' end as resultado
from reservas r join estado e on e.id = r.estado_id
where r.id = :r1;

\echo ''
\echo 'TEST 10 - IDEMPOTENCIA: el mismo webhook otra vez no vuelve a sumar'
select o_ya_procesado, o_total_pagado, o_saldo_pendiente,
       case when o_ya_procesado = true and o_total_pagado = 300000
            then 'PASS' else 'FAIL' end as resultado
from fn_registrar_pago_aprobado('res-abono-1001', 'BOLD-PAY-AAA', 300000);

\echo ''
\echo 'TEST 11 - Quedo la foto de auditoria en el pago (comprobante, CUS, saldo)'
select numero_comprobante, cus, total_reserva, saldo_despues, fecha_pago is not null as tiene_fecha,
       case when numero_comprobante = 'COMP-001' and cus = 'CUS-123'
                 and total_reserva = 940000 and saldo_despues = 640000
            then 'PASS' else 'FAIL' end as resultado
from pagos where referencia = 'res-abono-1001';

\echo ''
\echo 'TEST 12 - El borrador ya no vence despues de pagar (expira_at en NULL)'
select expira_at, case when expira_at is null then 'PASS' else 'FAIL' end as resultado
from reservas where id = :r1;

\echo ''
\echo 'TEST 13 - Paga el saldo restante -> la reserva queda pagada_total'
select o_total_pagado, o_saldo_pendiente, o_estado_pago,
       case when o_total_pagado = 940000 and o_saldo_pendiente = 0
                 and o_estado_pago = 'pagada_total'
            then 'PASS' else 'FAIL' end as resultado
from fn_registrar_pago_aprobado('res-total-1003', 'BOLD-PAY-BBB', 640000, 'COMP-002', 'CUS-456');

\echo ''
\echo 'TEST 14 - Ya no se puede abonar mas (saldo en 0, esperado: EXCEPTION)'
select fn_crear_pago_pendiente(:r1, 50000, 'abono', 'res-abono-3001');

\echo ''
\echo 'TEST 15 - Webhook con una referencia desconocida (esperado: EXCEPTION)'
select fn_registrar_pago_aprobado('res-inventada-000', 'BOLD-PAY-ZZZ', 100000);

\echo ''
\echo 'TEST 16 - ANTI DOBLE-RESERVA: mismo domo, fechas que se pisan (esperado: EXCEPTION)'
insert into reservas (cliente_id, domo_id, plan_id, fecha_reservada, fecha_fin_reserva,
                      numero_huespedes, valor_total, total, estado_id)
values ((select id from clientes where numero_documento = '1020304050'),
        (select min(id) from domos),
        (select id from planes where nombre = 'Romantico'),
        '2026-10-11', '2026-10-13', 2, 700000, 700000, fn_estado_id('borrador'));

\echo ''
\echo 'TEST 17 - Fechas que NO se pisan en el mismo domo si se permiten (check-out = check-in)'
insert into reservas (cliente_id, domo_id, plan_id, fecha_reservada, fecha_fin_reserva,
                      numero_huespedes, valor_total, total, saldo, estado_id)
values ((select id from clientes where numero_documento = '1020304050'),
        (select min(id) from domos),
        (select id from planes where nombre = 'Romantico'),
        '2026-10-12', '2026-10-14', 2, 700000, 700000, 700000, fn_estado_id('borrador'));

\echo ''
\echo 'TEST 18 - Rechaza un check-out anterior o igual al check-in (esperado: EXCEPTION)'
insert into reservas (cliente_id, domo_id, plan_id, fecha_reservada, fecha_fin_reserva,
                      numero_huespedes, valor_total, total, estado_id)
values ((select id from clientes where numero_documento = '1020304050'),
        (select max(id) from domos),
        (select id from planes where nombre = 'Romantico'),
        '2026-11-05', '2026-11-05', 2, 350000, 350000, fn_estado_id('borrador'));

\echo ''
\echo 'TEST 19 - Una reserva CANCELADA libera el domo (esperado: pasa sin error)'
update reservas set estado_id = fn_estado_id('cancel') where id = :r1;
insert into reservas (cliente_id, domo_id, plan_id, fecha_reservada, fecha_fin_reserva,
                      numero_huespedes, valor_total, total, estado_id)
values ((select id from clientes where numero_documento = '1020304050'),
        (select min(id) from domos),
        (select id from planes where nombre = 'Romantico'),
        '2026-10-10', '2026-10-12', 2, 700000, 700000, fn_estado_id('borrador'));

\echo ''
\echo 'TEST 20 - Vista de estado de cuenta'
select reserva_id, cliente, documento, total, pagado, saldo, estado_pago, estado_reserva, num_pagos
from v_estado_cuenta order by reserva_id;

\echo ''
\echo 'TEST 21 - Libro de transacciones completo de la reserva bajo prueba'
select id, tipo, valor, estado, numero_comprobante, cus, saldo_despues
from pagos where reserva_id = :r1 order by id;

\echo ''
\echo '=========================================='
\echo 'ROLLBACK: la base queda como estaba'
\echo '=========================================='
rollback;
