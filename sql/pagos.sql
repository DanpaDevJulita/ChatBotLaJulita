-- ============================================================
-- Glamping La Julita - Chatbot
-- MODULO DE PAGOS
-- ============================================================
-- Depende de: clientes, reservas, adicionales, reservas_adicionales
-- (ver schema.sql)
--
-- Decisiones de diseno:
--  1. El monto NUNCA es fijo: sale de la reserva (noches x tarifa) + adicionales.
--     La funcion fn_total_reserva() lo calcula, para que ni el bot ni el LLM
--     puedan inventar cifras.
--  2. Una reserva puede tener N pagos (abonos parciales). La tabla pagos es un
--     libro de transacciones: una fila por movimiento, nunca se sobreescribe.
--  3. El saldo pendiente se guarda DOS veces a proposito:
--       - reservas.saldo_pendiente  -> saldo vivo actual (para consultar rapido)
--       - pagos.saldo_despues       -> foto del saldo tras ESE pago (auditoria)
--     Asi se puede reconstruir la historia completa de la reserva.
--  4. fn_registrar_pago_aprobado() es idempotente: si Bold reintenta el webhook
--     con el mismo bold_payment_id, el segundo intento no vuelve a sumar.
-- ============================================================


-- ------------------------------------------------------------
-- 1. TABLA DE PAGOS (libro de transacciones)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pagos (
  id_pago             bigserial PRIMARY KEY,

  -- Trazabilidad obligatoria: siempre se sabe a que reserva y a que cliente
  id_reserva          bigint NOT NULL REFERENCES reservas(id_reserva) ON DELETE RESTRICT,
  id_cliente          bigint REFERENCES clientes(id_cliente),

  -- Que parte de la reserva cubre este movimiento
  tipo                text NOT NULL DEFAULT 'abono'
                        CHECK (tipo IN ('total', 'abono', 'saldo')),

  valor               numeric(12,2) NOT NULL CHECK (valor > 0),

  metodo              text NOT NULL DEFAULT 'bold'
                        CHECK (metodo IN ('bold', 'qr_emergencia', 'transferencia', 'efectivo')),

  estado              text NOT NULL DEFAULT 'pendiente'
                        CHECK (estado IN ('pendiente', 'aprobado', 'rechazado', 'expirado', 'anulado')),

  -- --- Identificadores del pago ---
  referencia          text UNIQUE,          -- nuestra reference: res{id}-{tipo}-{ts}
  bold_payment_id     text UNIQUE,          -- id que devuelve Bold (clave de idempotencia)
  numero_comprobante  text,                 -- numero de comprobante / recibo
  cus                 text,                 -- Clave Unica de Seguimiento (PSE/transferencias)
  payment_link        text,                 -- identificador del link en Bold
  link_url            text,                 -- URL de checkout hospedada por Bold
  comprobante_url     text,                 -- imagen del soporte (Supabase Storage)

  -- --- Foto del estado de la reserva tras este pago (auditoria) ---
  total_reserva       numeric(12,2),        -- total de la reserva al momento del pago
  saldo_despues       numeric(12,2),        -- saldo pendiente despues de aplicar este pago

  fecha_pago          timestamptz,          -- cuando Bold aprobo (no cuando se creo el link)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pagos_reserva      ON pagos(id_reserva);
CREATE INDEX IF NOT EXISTS idx_pagos_cliente      ON pagos(id_cliente);
CREATE INDEX IF NOT EXISTS idx_pagos_estado       ON pagos(estado);
CREATE INDEX IF NOT EXISTS idx_pagos_referencia   ON pagos(referencia);

-- Un solo link pendiente por reserva Y POR TIPO.
--
-- Es (id_reserva, tipo) y no solo (id_reserva) porque al huesped se le manda
-- el par de links a la vez: uno 'total' (monto fijo) y uno 'abono' (monto
-- abierto). Con unicidad solo por reserva, el segundo link fallaba.
-- Detectado en pruebas.
--
-- Lo que si sigue evitando: que el bot genere dos links del MISMO tipo si el
-- cliente insiste (reemplaza el chequeo fragil del bot base, que buscaba un
-- numero de telefono escrito a mano dentro del historial de mensajes).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagos_pendiente_por_reserva_tipo
  ON pagos(id_reserva, tipo)
  WHERE estado = 'pendiente';


-- ------------------------------------------------------------
-- 2. CALCULO DEL TOTAL (reserva + adicionales)
-- ------------------------------------------------------------
-- Fuente unica de verdad del monto. El bot llama esto, nunca calcula por su cuenta.

CREATE OR REPLACE FUNCTION fn_total_reserva(p_id_reserva bigint)
RETURNS numeric AS $$
DECLARE
  v_alojamiento numeric(12,2);
  v_adicionales numeric(12,2);
BEGIN
  SELECT COALESCE(monto_total, 0) INTO v_alojamiento
  FROM reservas WHERE id_reserva = p_id_reserva;

  IF v_alojamiento IS NULL THEN
    RAISE EXCEPTION 'La reserva % no existe', p_id_reserva;
  END IF;

  SELECT COALESCE(SUM(cantidad * precio_unitario), 0) INTO v_adicionales
  FROM reservas_adicionales WHERE id_reserva = p_id_reserva;

  RETURN v_alojamiento + v_adicionales;
END;
$$ LANGUAGE plpgsql STABLE;


CREATE OR REPLACE FUNCTION fn_pagado_reserva(p_id_reserva bigint)
RETURNS numeric AS $$
  SELECT COALESCE(SUM(valor), 0)
  FROM pagos
  WHERE id_reserva = p_id_reserva AND estado = 'aprobado';
$$ LANGUAGE sql STABLE;


CREATE OR REPLACE FUNCTION fn_saldo_reserva(p_id_reserva bigint)
RETURNS numeric AS $$
  SELECT fn_total_reserva(p_id_reserva) - fn_pagado_reserva(p_id_reserva);
$$ LANGUAGE sql STABLE;


-- ------------------------------------------------------------
-- 3. REGISTRAR UN PAGO APROBADO (idempotente)
-- ------------------------------------------------------------
-- La llama el webhook de Bold. Hace todo en una transaccion:
--   a) marca el pago como aprobado (solo si estaba pendiente)
--   b) recalcula total, pagado y saldo
--   c) guarda la foto de auditoria en el propio pago
--   d) actualiza el estado de la reserva
--
-- Si Bold reintenta el webhook (lo hace hasta 5 veces en 24h), la segunda
-- llamada no hace nada y devuelve ya_procesado = true.

CREATE OR REPLACE FUNCTION fn_registrar_pago_aprobado(
  p_referencia         text,
  p_bold_payment_id    text,
  p_valor              numeric DEFAULT NULL,
  p_numero_comprobante text DEFAULT NULL,
  p_cus                text DEFAULT NULL,
  p_fecha_pago         timestamptz DEFAULT now()
)
-- NOTA: las columnas de salida van con prefijo o_ a proposito. Si se llaman
-- igual que las columnas de la tabla (id_pago, saldo_pendiente, ...), Postgres
-- lanza "column reference is ambiguous" dentro de los UPDATE de esta funcion
-- y el webhook falla entero. Detectado en pruebas antes de salir a produccion.
RETURNS TABLE (
  o_ok              boolean,
  o_ya_procesado    boolean,
  o_id_pago         bigint,
  o_id_reserva      bigint,
  o_total_reserva   numeric,
  o_total_pagado    numeric,
  o_saldo_pendiente numeric,
  o_estado_pago     text,
  o_estado_reserva  text
) AS $$
DECLARE
  v_pago     pagos;
  v_total    numeric(12,2);
  v_pagado   numeric(12,2);
  v_saldo    numeric(12,2);
  v_est_pago text;
  v_est_res  text;
BEGIN
  SELECT * INTO v_pago FROM pagos WHERE referencia = p_referencia FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe un pago con referencia %', p_referencia;
  END IF;

  -- Idempotencia: si ya estaba aprobado, no se vuelve a aplicar.
  IF v_pago.estado = 'aprobado' THEN
    v_total  := fn_total_reserva(v_pago.id_reserva);
    v_pagado := fn_pagado_reserva(v_pago.id_reserva);
    RETURN QUERY SELECT true, true, v_pago.id_pago, v_pago.id_reserva,
                        v_total, v_pagado, v_total - v_pagado,
                        (SELECT r.estado_pago FROM reservas r WHERE r.id_reserva = v_pago.id_reserva),
                        (SELECT r.estado_reserva FROM reservas r WHERE r.id_reserva = v_pago.id_reserva);
    RETURN;
  END IF;

  UPDATE pagos SET
    estado             = 'aprobado',
    bold_payment_id    = COALESCE(p_bold_payment_id, bold_payment_id),
    valor              = COALESCE(p_valor, valor),
    numero_comprobante = COALESCE(p_numero_comprobante, numero_comprobante),
    cus                = COALESCE(p_cus, cus),
    fecha_pago         = p_fecha_pago,
    updated_at         = now()
  WHERE pagos.id_pago = v_pago.id_pago;

  v_total  := fn_total_reserva(v_pago.id_reserva);
  v_pagado := fn_pagado_reserva(v_pago.id_reserva);
  v_saldo  := v_total - v_pagado;

  -- Foto de auditoria en el propio movimiento
  UPDATE pagos SET total_reserva = v_total, saldo_despues = v_saldo
  WHERE pagos.id_pago = v_pago.id_pago;

  -- Estado derivado del dinero, nunca de lo que diga el cliente en el chat
  IF v_pagado <= 0 THEN
    v_est_pago := 'sin_pago';
  ELSIF v_saldo > 0 THEN
    v_est_pago := 'con_anticipo';
  ELSE
    v_est_pago := 'pagada_total';
  END IF;

  UPDATE reservas SET
    monto_pagado    = v_pagado,
    saldo_pendiente = v_saldo,
    estado_pago     = v_est_pago,
    -- Cualquier pago aprobado confirma la reserva (parcial o total).
    -- No se toca si ya estaba cancelada o completada.
    estado_reserva  = CASE WHEN reservas.estado_reserva = 'borrador' THEN 'confirmada' ELSE reservas.estado_reserva END,
    confirmed_at    = COALESCE(reservas.confirmed_at, p_fecha_pago),
    expira_at       = NULL   -- ya pago: el borrador no expira
  WHERE reservas.id_reserva = v_pago.id_reserva
  RETURNING reservas.estado_reserva INTO v_est_res;

  RETURN QUERY SELECT true, false, v_pago.id_pago, v_pago.id_reserva,
                      v_total, v_pagado, v_saldo, v_est_pago, v_est_res;
END;
$$ LANGUAGE plpgsql;


-- ------------------------------------------------------------
-- 4. CREAR UN PAGO PENDIENTE (antes de mandar el link)
-- ------------------------------------------------------------
-- Valida que el monto tenga sentido ANTES de generar el link en Bold:
-- no se puede abonar mas de lo que se debe, ni montos de cero o negativos.

CREATE OR REPLACE FUNCTION fn_crear_pago_pendiente(
  p_id_reserva  bigint,
  p_valor       numeric,
  p_tipo        text,
  p_referencia  text,
  p_metodo      text DEFAULT 'bold'
)
RETURNS bigint AS $$
DECLARE
  v_saldo     numeric(12,2);
  v_cliente   bigint;
  v_id_pago   bigint;
BEGIN
  SELECT id_cliente INTO v_cliente FROM reservas WHERE id_reserva = p_id_reserva;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La reserva % no existe', p_id_reserva;
  END IF;

  v_saldo := fn_saldo_reserva(p_id_reserva);

  IF p_valor <= 0 THEN
    RAISE EXCEPTION 'El valor a pagar debe ser mayor que cero (recibido: %)', p_valor;
  END IF;

  IF p_valor > v_saldo THEN
    RAISE EXCEPTION 'El valor % excede el saldo pendiente de la reserva (%)', p_valor, v_saldo;
  END IF;

  INSERT INTO pagos (id_reserva, id_cliente, tipo, valor, metodo, referencia, estado)
  VALUES (p_id_reserva, v_cliente, p_tipo, p_valor, p_metodo, p_referencia, 'pendiente')
  RETURNING id_pago INTO v_id_pago;

  RETURN v_id_pago;
END;
$$ LANGUAGE plpgsql;


-- ------------------------------------------------------------
-- 5. VISTA DE ESTADO DE CUENTA POR RESERVA
-- ------------------------------------------------------------
-- Lo que el Agente de Pagos consulta para responder "cuanto debo".

CREATE OR REPLACE VIEW v_estado_cuenta AS
SELECT
  r.id_reserva,
  r.id_cliente,
  c.nombre                        AS cliente,
  c.cedula,
  r.fecha_checkin,
  r.fecha_checkout,
  fn_total_reserva(r.id_reserva)  AS total,
  fn_pagado_reserva(r.id_reserva) AS pagado,
  fn_saldo_reserva(r.id_reserva)  AS saldo,
  r.estado_pago,
  r.estado_reserva,
  (SELECT COUNT(*) FROM pagos p WHERE p.id_reserva = r.id_reserva AND p.estado = 'aprobado') AS num_pagos
FROM reservas r
LEFT JOIN clientes c ON c.id_cliente = r.id_cliente;

-- ============================================================
-- FIN
-- ============================================================
