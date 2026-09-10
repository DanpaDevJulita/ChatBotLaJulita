\set ON_ERROR_STOP off
\pset pager off

-- ============================================================
-- PRUEBAS DEL MODULO DE PAGOS - Glamping La Julita
-- ============================================================
-- Corre contra una base LIMPIA (o una copia): inserta datos de prueba.
-- Requiere sql/schema.sql y sql/pagos.sql ya aplicados.
-- ON_ERROR_STOP off a proposito: varios tests esperan que la funcion LANCE
-- una excepcion; si el script se detuviera en la primera, no se verian los demas.
-- ============================================================

\echo '=========================================='
\echo 'SETUP: datos de prueba'
\echo '=========================================='

INSERT INTO clientes (cedula, nombre, email, celular)
VALUES ('1020304050', 'Ana Perez', 'ana@test.co', '+573001112233');

INSERT INTO domos (nombre, capacidad_maxima, tarifa_base)
VALUES ('Domo Luna', 2, 350000), ('Domo Sol', 4, 480000);

INSERT INTO planes (nombre, costo_adicional_plan) VALUES ('romantico', 120000);
INSERT INTO planes_domos (id_plan, id_domo) VALUES (1, 1);

INSERT INTO adicionales (nombre, categoria, precio) VALUES
  ('Decoracion romantica', 'decoracion', 90000),
  ('Cena especial', 'servicio', 150000);

-- Reserva: 2 noches en Domo Luna. monto_total = alojamiento (2 x 350.000)
INSERT INTO reservas (id_cliente, id_domo, id_plan, fecha_checkin, fecha_checkout,
                      numero_huespedes, monto_total, saldo_pendiente, expira_at)
VALUES (1, 1, 1, '2026-10-10', '2026-10-12', 2, 700000, 700000, now() + interval '4 hours');

-- Adicionales pedidos: decoracion + cena = 240.000
INSERT INTO reservas_adicionales (id_reserva, id_adicional, cantidad, precio_unitario)
VALUES (1, 1, 1, 90000), (1, 2, 1, 150000);

\echo ''
\echo 'TEST 1 - El total suma alojamiento + adicionales (esperado: 940000)'
SELECT fn_total_reserva(1) AS total,
       CASE WHEN fn_total_reserva(1) = 940000 THEN 'PASS' ELSE 'FAIL' END AS resultado;

\echo ''
\echo 'TEST 2 - Saldo inicial = total, pagado = 0'
SELECT fn_pagado_reserva(1) AS pagado, fn_saldo_reserva(1) AS saldo,
       CASE WHEN fn_pagado_reserva(1) = 0 AND fn_saldo_reserva(1) = 940000
            THEN 'PASS' ELSE 'FAIL' END AS resultado;

\echo ''
\echo 'TEST 3 - Rechaza abono mayor al saldo (esperado: EXCEPTION)'
SELECT fn_crear_pago_pendiente(1, 2000000, 'abono', 'res1-abono-999');

\echo ''
\echo 'TEST 4 - Rechaza monto cero o negativo (esperado: EXCEPTION)'
SELECT fn_crear_pago_pendiente(1, 0, 'abono', 'res1-abono-998');

\echo ''
\echo 'TEST 5 - Crea un abono valido de 300000'
SELECT fn_crear_pago_pendiente(1, 300000, 'abono', 'res1-abono-1001') AS id_pago;

\echo ''
\echo 'TEST 6 - Bloquea un SEGUNDO link pendiente para la misma reserva (esperado: EXCEPTION)'
SELECT fn_crear_pago_pendiente(1, 100000, 'abono', 'res1-abono-1002');

\echo ''
\echo 'TEST 7 - Aprueba el abono de 300000 via webhook'
SELECT o_ya_procesado, o_total_reserva, o_total_pagado, o_saldo_pendiente, o_estado_pago, o_estado_reserva
FROM fn_registrar_pago_aprobado('res1-abono-1001', 'BOLD-PAY-AAA', 300000, 'COMP-001', 'CUS-123');

\echo ''
\echo 'TEST 8 - La reserva quedo confirmada con saldo 640000'
SELECT estado_reserva, estado_pago, monto_pagado, saldo_pendiente,
       CASE WHEN estado_reserva='confirmada' AND estado_pago='con_anticipo'
                 AND monto_pagado=300000 AND saldo_pendiente=640000
            THEN 'PASS' ELSE 'FAIL' END AS resultado
FROM reservas WHERE id_reserva = 1;

\echo ''
\echo 'TEST 9 - IDEMPOTENCIA: el mismo webhook otra vez no vuelve a sumar'
SELECT o_ya_procesado, o_total_pagado, o_saldo_pendiente,
       CASE WHEN o_ya_procesado = true AND o_total_pagado = 300000
            THEN 'PASS' ELSE 'FAIL' END AS resultado
FROM fn_registrar_pago_aprobado('res1-abono-1001', 'BOLD-PAY-AAA', 300000);

\echo ''
\echo 'TEST 10 - Se guardo la foto de auditoria en el pago (comprobante, CUS, saldo)'
SELECT numero_comprobante, cus, total_reserva, saldo_despues, fecha_pago IS NOT NULL AS tiene_fecha,
       CASE WHEN numero_comprobante='COMP-001' AND cus='CUS-123'
                 AND total_reserva=940000 AND saldo_despues=640000
            THEN 'PASS' ELSE 'FAIL' END AS resultado
FROM pagos WHERE referencia = 'res1-abono-1001';

\echo ''
\echo 'TEST 11 - El borrador ya no expira despues de pagar (expira_at NULL)'
SELECT expira_at, CASE WHEN expira_at IS NULL THEN 'PASS' ELSE 'FAIL' END AS resultado
FROM reservas WHERE id_reserva = 1;

\echo ''
\echo 'TEST 12 - Ahora si permite un nuevo link (el anterior ya no esta pendiente)'
SELECT fn_crear_pago_pendiente(1, 640000, 'saldo', 'res1-saldo-2001') AS id_pago;

\echo ''
\echo 'TEST 13 - Paga el saldo restante -> reserva pagada_total'
SELECT o_total_pagado, o_saldo_pendiente, o_estado_pago,
       CASE WHEN o_total_pagado=940000 AND o_saldo_pendiente=0 AND o_estado_pago='pagada_total'
            THEN 'PASS' ELSE 'FAIL' END AS resultado
FROM fn_registrar_pago_aprobado('res1-saldo-2001', 'BOLD-PAY-BBB', 640000, 'COMP-002', 'CUS-456');

\echo ''
\echo 'TEST 14 - Ya no se puede abonar mas (saldo en 0, esperado: EXCEPTION)'
SELECT fn_crear_pago_pendiente(1, 50000, 'abono', 'res1-abono-3001');

\echo ''
\echo 'TEST 15 - Webhook con referencia desconocida (esperado: EXCEPTION)'
SELECT fn_registrar_pago_aprobado('res99-total-000', 'BOLD-PAY-ZZZ', 100000);

\echo ''
\echo 'TEST 16 - ANTI DOBLE-RESERVA: mismo domo, fechas solapadas (esperado: EXCEPTION)'
INSERT INTO reservas (id_cliente, id_domo, fecha_checkin, fecha_checkout, numero_huespedes, monto_total)
VALUES (1, 1, '2026-10-11', '2026-10-13', 2, 700000);

\echo ''
\echo 'TEST 17 - Fechas NO solapadas en el mismo domo si se permiten'
INSERT INTO reservas (id_cliente, id_domo, fecha_checkin, fecha_checkout, numero_huespedes, monto_total)
VALUES (1, 1, '2026-10-12', '2026-10-14', 2, 700000);

\echo ''
\echo 'TEST 18 - Rechaza checkout anterior o igual al checkin (esperado: EXCEPTION)'
INSERT INTO reservas (id_cliente, id_domo, fecha_checkin, fecha_checkout, numero_huespedes, monto_total)
VALUES (1, 2, '2026-11-05', '2026-11-05', 2, 350000);

\echo ''
\echo 'TEST 19 - Vista de estado de cuenta'
SELECT id_reserva, cliente, total, pagado, saldo, estado_pago, num_pagos
FROM v_estado_cuenta ORDER BY id_reserva;

\echo ''
\echo 'TEST 20 - Libro de transacciones completo de la reserva 1'
SELECT id_pago, tipo, valor, estado, numero_comprobante, cus, saldo_despues
FROM pagos WHERE id_reserva = 1 ORDER BY id_pago;

\echo ''
\echo 'TEST 21 - PAR DE LINKS: total + abono pendientes en la misma reserva (deben convivir)'
SELECT fn_crear_pago_pendiente(3, 700000, 'total', 'res3-total-5001') AS link_total;
SELECT fn_crear_pago_pendiente(3, 700000, 'abono', 'res3-abono-5002') AS link_abono;

\echo ''
\echo 'TEST 22 - Bloquea un SEGUNDO link del MISMO tipo (esperado: EXCEPTION)'
SELECT fn_crear_pago_pendiente(3, 700000, 'total', 'res3-total-5003');

\echo ''
\echo 'TEST 23 - SOBREPAGO: el huesped digita mas que el saldo en el link OPEN'
\echo '           (Bold no valida el monto; se registra tal cual y el saldo queda NEGATIVO)'
SELECT o_total_pagado, o_saldo_pendiente, o_estado_pago
FROM fn_registrar_pago_aprobado('res3-abono-5002', 'BOLD-PAY-CCC', 900000, 'COMP-003', 'CUS-789');

\echo ''
\echo 'TEST 24 - Estado de cuenta con el sobrepago'
SELECT id_reserva, total, pagado, saldo, estado_pago FROM v_estado_cuenta WHERE id_reserva = 3;
