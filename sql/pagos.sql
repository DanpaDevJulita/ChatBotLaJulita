-- ============================================================================================
-- Glamping La Julita - Chatbot
-- MODULO DE PAGOS
-- ============================================================================================
-- Correr DESPUES de sql/schema.sql y sql/pagos-migracion-reservas.sql.
--
-- [2026-09-10] Este archivo se reescribio contra el esquema REAL de Supabase. La version
-- anterior (guardada en _to_delete/pagos.sql.version-diseno.txt) usaba los nombres del
-- documento de diseno -- id_reserva, monto_total, fecha_checkin, reservas_adicionales -- que
-- no existen en la base. Nombres reales que se usan aca:
--     reservas.id, reservas.cliente_id, reservas.total, reservas.anticipo, reservas.saldo,
--     reservas.estado_id -> estado(descripcion), reservas.fecha_reservada (= check-in),
--     adicionales_reserva(reserva_id, adicionales_id, cantidad, precio_unitario),
--     clientes.id, clientes.numero_documento
--
-- DECISIONES DE DISENO
--  1. El monto NUNCA es fijo: sale de la reserva (tarifa del plan/domo) + adicionales.
--     fn_total_reserva() lo calcula, para que ni el bot ni el LLM puedan inventar cifras.
--  2. Una reserva puede tener N pagos (abonos parciales). `pagos` es un libro de
--     transacciones: una fila por movimiento, nunca se sobreescribe.
--  3. El saldo se guarda DOS veces a proposito:
--       - reservas.saldo      -> saldo vivo actual (para consultar rapido)
--       - pagos.saldo_despues -> foto del saldo tras ESE pago (auditoria)
--     Asi se puede reconstruir la historia completa de la reserva.
--  4. fn_registrar_pago_aprobado() es idempotente: si Bold reintenta el webhook (lo hace
--     hasta 5 veces en 24h), el segundo intento no vuelve a sumar.
-- ============================================================================================


-- --------------------------------------------------------------------------------------------
-- 1. TABLA DE PAGOS (libro de transacciones)
-- --------------------------------------------------------------------------------------------

create table if not exists pagos (
  id                  bigserial primary key,

  -- Trazabilidad obligatoria: siempre se sabe a que reserva y a que cliente
  reserva_id          int not null references reservas(id) on delete restrict,
  cliente_id          int references clientes(id),

  -- Que parte de la reserva cubre este movimiento
  tipo                text not null default 'abono'
                        check (tipo in ('total', 'abono', 'saldo')),

  valor               numeric(12,2) not null check (valor > 0),

  metodo              text not null default 'bold'
                        check (metodo in ('bold', 'qr_emergencia', 'transferencia', 'efectivo')),

  estado              text not null default 'pendiente'
                        check (estado in ('pendiente', 'aprobado', 'rechazado', 'expirado', 'anulado')),

  -- --- Identificadores del pago ---
  referencia          text unique,          -- la nuestra: res{id}-{tipo}-{timestamp}
  bold_payment_id     text unique,          -- el id que devuelve Bold (clave de idempotencia)
  numero_comprobante  text,                 -- numero de comprobante / recibo
  cus                 text,                 -- Clave Unica de Seguimiento (PSE/transferencias)
  payment_link        text,                 -- identificador del link en Bold
  link_url            text,                 -- URL de checkout hospedada por Bold
  comprobante_url     text,                 -- imagen del soporte (Supabase Storage)

  -- --- Foto del estado de la reserva tras este pago (auditoria) ---
  total_reserva       numeric(12,2),
  saldo_despues       numeric(12,2),

  fecha_pago          timestamptz,          -- cuando Bold aprobo (no cuando se creo el link)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists pagos_reserva_id_idx  on pagos (reserva_id);
create index if not exists pagos_cliente_id_idx  on pagos (cliente_id);
create index if not exists pagos_estado_idx      on pagos (estado);
create index if not exists pagos_referencia_idx  on pagos (referencia);

-- Un solo link pendiente por reserva Y POR TIPO.
--
-- Es (reserva_id, tipo) y no solo (reserva_id) porque al huesped se le mandan los dos links a
-- la vez: uno 'total' (monto fijo, modalidad CLOSE de Bold) y uno 'abono' (monto abierto,
-- modalidad OPEN). Con unicidad solo por reserva, el segundo link fallaba.
--
-- Lo que si sigue evitando: que el bot genere dos links del MISMO tipo si el cliente insiste.
create unique index if not exists pagos_pendiente_por_reserva_tipo_uq
  on pagos (reserva_id, tipo)
  where estado = 'pendiente';


-- --------------------------------------------------------------------------------------------
-- 2. CALCULO DEL TOTAL (alojamiento + adicionales)
-- --------------------------------------------------------------------------------------------
-- Fuente unica de verdad del monto. El bot llama esto, nunca calcula por su cuenta.

create or replace function fn_total_reserva(p_reserva_id int)
returns numeric as $$
declare
  v_alojamiento numeric(12,2);
  v_adicionales numeric(12,2);
  v_existe      boolean;
begin
  -- `total` es el valor final; `valor_total` es el valor base segun el plan. Se prefiere
  -- `total` y se cae a `valor_total` porque reservasRepo.ts hoy escribe los dos iguales.
  select true, coalesce(r.total, r.valor_total, 0)
    into v_existe, v_alojamiento
    from reservas r
   where r.id = p_reserva_id;

  if not found then
    raise exception 'La reserva % no existe', p_reserva_id;
  end if;

  -- precio_unitario queda congelado al agregar el adicional; si falta, se cae al vigente.
  select coalesce(sum(ar.cantidad * coalesce(ar.precio_unitario, a.precio, 0)), 0)
    into v_adicionales
    from adicionales_reserva ar
    join adicionales a on a.id = ar.adicionales_id
   where ar.reserva_id = p_reserva_id;

  return v_alojamiento + v_adicionales;
end;
$$ language plpgsql stable;


create or replace function fn_pagado_reserva(p_reserva_id int)
returns numeric as $$
  select coalesce(sum(valor), 0)
    from pagos
   where reserva_id = p_reserva_id and estado = 'aprobado';
$$ language sql stable;


create or replace function fn_saldo_reserva(p_reserva_id int)
returns numeric as $$
  select fn_total_reserva(p_reserva_id) - fn_pagado_reserva(p_reserva_id);
$$ language sql stable;


-- --------------------------------------------------------------------------------------------
-- 3. CREAR UN PAGO PENDIENTE (antes de mandar el link)
-- --------------------------------------------------------------------------------------------
-- Valida que el monto tenga sentido ANTES de generar el link en Bold: no se puede abonar mas
-- de lo que se debe, ni montos de cero o negativos.

create or replace function fn_crear_pago_pendiente(
  p_reserva_id  int,
  p_valor       numeric,
  p_tipo        text,
  p_referencia  text,
  p_metodo      text default 'bold'
)
returns bigint as $$
declare
  v_saldo   numeric(12,2);
  v_cliente int;
  v_id_pago bigint;
begin
  select r.cliente_id into v_cliente from reservas r where r.id = p_reserva_id;
  if not found then
    raise exception 'La reserva % no existe', p_reserva_id;
  end if;

  if p_valor <= 0 then
    raise exception 'El valor a pagar debe ser mayor que cero (recibido: %)', p_valor;
  end if;

  v_saldo := fn_saldo_reserva(p_reserva_id);

  if p_valor > v_saldo then
    raise exception 'El valor % excede el saldo pendiente de la reserva (%)', p_valor, v_saldo;
  end if;

  insert into pagos (reserva_id, cliente_id, tipo, valor, metodo, referencia, estado)
  values (p_reserva_id, v_cliente, p_tipo, p_valor, p_metodo, p_referencia, 'pendiente')
  returning id into v_id_pago;

  return v_id_pago;
end;
$$ language plpgsql;


-- --------------------------------------------------------------------------------------------
-- 4. REGISTRAR UN PAGO APROBADO (idempotente)
-- --------------------------------------------------------------------------------------------
-- La llama el webhook de Bold. Hace todo en una transaccion:
--   a) marca el pago como aprobado (solo si estaba pendiente)
--   b) recalcula total, pagado y saldo
--   c) guarda la foto de auditoria en el propio pago
--   d) actualiza el estado de la reserva
--
-- NOTA: las columnas de salida van con prefijo o_ a proposito. Si se llaman igual que las
-- columnas de la tabla, Postgres lanza "column reference is ambiguous" adentro de los UPDATE
-- de esta funcion y el webhook falla entero.

create or replace function fn_registrar_pago_aprobado(
  p_referencia         text,
  p_bold_payment_id    text,
  p_valor              numeric     default null,
  p_numero_comprobante text        default null,
  p_cus                text        default null,
  p_fecha_pago         timestamptz default now()
)
returns table (
  o_ok              boolean,
  o_ya_procesado    boolean,
  o_id_pago         bigint,
  o_reserva_id      int,
  o_total_reserva   numeric,
  o_total_pagado    numeric,
  o_saldo_pendiente numeric,
  o_estado_pago     text,
  o_estado_reserva  text
) as $$
declare
  v_pago     pagos;
  v_total    numeric(12,2);
  v_pagado   numeric(12,2);
  v_saldo    numeric(12,2);
  v_est_pago text;
  v_est_res  text;
begin
  select * into v_pago from pagos where referencia = p_referencia for update;

  if not found then
    raise exception 'No existe un pago con referencia %', p_referencia;
  end if;

  -- Idempotencia: si ya estaba aprobado, no se vuelve a aplicar.
  if v_pago.estado = 'aprobado' then
    v_total  := fn_total_reserva(v_pago.reserva_id);
    v_pagado := fn_pagado_reserva(v_pago.reserva_id);
    return query
      select true, true, v_pago.id, v_pago.reserva_id,
             v_total, v_pagado, v_total - v_pagado,
             r.estado_pago,
             e.descripcion
        from reservas r
        join estado e on e.id = r.estado_id
       where r.id = v_pago.reserva_id;
    return;
  end if;

  update pagos set
    estado             = 'aprobado',
    bold_payment_id    = coalesce(p_bold_payment_id, pagos.bold_payment_id),
    valor              = coalesce(p_valor, pagos.valor),
    numero_comprobante = coalesce(p_numero_comprobante, pagos.numero_comprobante),
    cus                = coalesce(p_cus, pagos.cus),
    fecha_pago         = p_fecha_pago,
    updated_at         = now()
  where pagos.id = v_pago.id;

  v_total  := fn_total_reserva(v_pago.reserva_id);
  v_pagado := fn_pagado_reserva(v_pago.reserva_id);
  v_saldo  := v_total - v_pagado;

  -- Foto de auditoria en el propio movimiento
  update pagos set total_reserva = v_total, saldo_despues = v_saldo
   where pagos.id = v_pago.id;

  -- El estado sale del dinero, nunca de lo que diga el cliente en el chat
  if v_pagado <= 0 then
    v_est_pago := 'sin_pago';
  elsif v_saldo > 0 then
    v_est_pago := 'con_anticipo';
  else
    v_est_pago := 'pagada_total';
  end if;

  -- Cualquier pago aprobado confirma la reserva (parcial o total). No se toca si el equipo
  -- ya la marco como cancelada o completada.
  update reservas r set
    anticipo     = v_pagado,
    saldo        = v_saldo,
    total        = coalesce(r.total, v_total),
    estado_pago  = v_est_pago,
    estado_id    = case
                     when unaccent(lower((select e.descripcion from estado e where e.id = r.estado_id)))
                          ~ '(cancel|complet)'
                       then r.estado_id
                     else fn_estado_id('confirmad')
                   end,
    confirmed_at = coalesce(r.confirmed_at, p_fecha_pago),
    expira_at    = null   -- ya pago: el borrador deja de vencer
   where r.id = v_pago.reserva_id;

  select e.descripcion into v_est_res
    from reservas r join estado e on e.id = r.estado_id
   where r.id = v_pago.reserva_id;

  return query select true, false, v_pago.id, v_pago.reserva_id,
                      v_total, v_pagado, v_saldo, v_est_pago, v_est_res;
end;
$$ language plpgsql;


-- --------------------------------------------------------------------------------------------
-- 5. VISTA DE ESTADO DE CUENTA POR RESERVA
-- --------------------------------------------------------------------------------------------
-- Lo que el Agente de Pagos consulta para responder "cuanto debo".

create or replace view v_estado_cuenta as
select
  r.id                            as reserva_id,
  r.cliente_id,
  c.nombre                        as cliente,
  c.numero_documento              as documento,
  c.celular,
  r.fecha_reservada               as fecha_checkin,
  r.fecha_fin_reserva,
  fn_total_reserva(r.id)          as total,
  fn_pagado_reserva(r.id)         as pagado,
  fn_saldo_reserva(r.id)          as saldo,
  r.estado_pago,
  e.descripcion                   as estado_reserva,
  r.expira_at,
  r.confirmed_at,
  (select count(*) from pagos p where p.reserva_id = r.id and p.estado = 'aprobado') as num_pagos
from reservas r
left join clientes c on c.id = r.cliente_id
left join estado   e on e.id = r.estado_id;

-- ============================================================================================
-- FIN
-- ============================================================================================
