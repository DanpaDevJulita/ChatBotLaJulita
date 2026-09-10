-- ============================================================================================
-- MIGRACION previa al modulo de pagos - Glamping La Julita
-- Fecha: 2026-09-10
--
-- POR QUE EXISTE ESTE ARCHIVO
-- `sql/pagos.sql` se habia escrito contra el modelo de DISENO (id_reserva, monto_total,
-- fecha_checkin/fecha_fin_reserva, reservas_adicionales...) y no contra las tablas que de verdad
-- existen en Supabase (id, cliente_id, total, fecha_reservada, adicionales_reserva...).
-- Aplicado tal cual, fallaba. Esta migracion cierra esa brecha SIN renombrar nada, para no
-- romper `src/core/db/reservasRepo.ts` ni el trabajo de la otra rama.
--
-- QUE SE REUSA (no se crea columna nueva para esto):
--   reservas.total   -> monto total de la reserva
--   reservas.anticipo-> cuanto lleva pagado
--   reservas.saldo   -> cuanto falta
--   reservas.estado_id -> estado de la reserva (tabla `estado`, texto libre)
--   reservas.fecha_reservada -> fecha de CHECK-IN
--
-- QUE SE AGREGA (lo que de verdad faltaba):
--   reservas.fecha_fin_reserva, estado_pago, expira_at, confirmed_at
--   adicionales_reserva.cantidad, precio_unitario
--
-- Todo es aditivo e idempotente: se puede correr dos veces sin dano.
-- Correr en Supabase -> SQL Editor, ANTES de sql/pagos.sql.
-- ============================================================================================


-- --------------------------------------------------------------------------------------------
-- 0. Extensiones
-- --------------------------------------------------------------------------------------------
-- unaccent() se usa mas abajo dentro de fn_estado_id() y del trigger anti doble-reserva.
-- Va primero porque Postgres valida el cuerpo de una funcion al crearla: si la extension no
-- existe todavia, la creacion de la funcion falla.

create extension if not exists unaccent;


-- --------------------------------------------------------------------------------------------
-- 1. La estadia necesita DOS fechas, no una
-- --------------------------------------------------------------------------------------------
-- `fecha_reservada` pasa a leerse como el check-in. Se agrega el check-out en vez de renombrar
-- porque reservasRepo.ts ya escribe y ordena por `fecha_reservada`.

alter table reservas add column if not exists fecha_fin_reserva date;

comment on column reservas.fecha_reservada   is 'Fecha de INICIO de la estadia (check-in).';
comment on column reservas.fecha_fin_reserva is 'Fecha de FIN de la estadia (check-out). Debe ser posterior a fecha_reservada. Nula mientras la reserva se esta armando.';

alter table reservas drop constraint if exists reservas_fechas_chk;
alter table reservas add constraint reservas_fechas_chk
  check (fecha_fin_reserva is null or fecha_fin_reserva > fecha_reservada);


-- --------------------------------------------------------------------------------------------
-- 2. Estado del PAGO (distinto del estado de la reserva)
-- --------------------------------------------------------------------------------------------
-- El estado de la reserva sigue viviendo en `estado_id` -> tabla `estado`. Lo que no existia
-- era el estado del dinero, que se deriva de los pagos aprobados y nunca de lo que diga el
-- cliente en el chat.

alter table reservas add column if not exists estado_pago text not null default 'sin_pago';

alter table reservas drop constraint if exists reservas_estado_pago_chk;
alter table reservas add constraint reservas_estado_pago_chk
  check (estado_pago in ('sin_pago', 'con_anticipo', 'pagada_total'));

comment on column reservas.estado_pago is
  'Derivado de los pagos aprobados: sin_pago / con_anticipo / pagada_total. Lo escribe fn_registrar_pago_aprobado(), nunca el bot.';


-- --------------------------------------------------------------------------------------------
-- 3. Vencimiento del borrador y momento de confirmacion
-- --------------------------------------------------------------------------------------------
-- Un borrador sin pago bloquea un domo. Si nunca expira, un cliente que no vuelve a escribir
-- deja la fecha muerta (seccion 14.5 del analisis).

alter table reservas add column if not exists expira_at    timestamptz;
alter table reservas add column if not exists confirmed_at timestamptz;

comment on column reservas.expira_at is
  'Cuando vence un borrador sin pago y el domo se libera. Se pone en NULL apenas entra un pago.';
comment on column reservas.confirmed_at is
  'Momento del primer pago aprobado (parcial o total).';

create index if not exists reservas_expira_at_idx on reservas (expira_at)
  where expira_at is not null;


-- --------------------------------------------------------------------------------------------
-- 3-bis. El domo se asigna despues, no al crear la reserva
-- --------------------------------------------------------------------------------------------
-- `domo_id` era NOT NULL y el bot no tiene ese dato cuando arranca a cotizar: elige el domo
-- recien cuando ya sabe plan, fechas y numero de huespedes (seccion 14.3 del analisis). El
-- diagnostico del 2026-09-08 lo reporto como el motivo por el que el insert de una reserva
-- fallaba. Se vuelve opcional para que la base y el codigo digan lo mismo.
--
-- El trigger anti doble-reserva (punto 6) ya contempla domo_id nulo: una reserva sin domo
-- asignado no bloquea el cupo de nadie.

alter table reservas alter column domo_id drop not null;

comment on column reservas.domo_id is
  'Domo asignado. NULO mientras la reserva se esta cotizando: el bot lo asigna cuando ya sabe plan, fechas y huespedes.';


-- --------------------------------------------------------------------------------------------
-- 4. Los adicionales necesitan cantidad y precio congelado
-- --------------------------------------------------------------------------------------------
-- `adicionales_reserva` solo guardaba que adicional se pidio. Sin cantidad no se puede pedir
-- dos decoraciones, y sin precio_unitario el total de una reserva vieja cambiaria solo con
-- que alguien edite la lista de precios. El precio se congela al momento de agregarlo.

alter table adicionales_reserva add column if not exists cantidad        int not null default 1;
alter table adicionales_reserva add column if not exists precio_unitario numeric(12,2);

alter table adicionales_reserva drop constraint if exists adicionales_reserva_cantidad_chk;
alter table adicionales_reserva add constraint adicionales_reserva_cantidad_chk
  check (cantidad > 0);

comment on column adicionales_reserva.precio_unitario is
  'Precio congelado al momento de agregar el adicional. Si es NULL se cae al precio vigente en adicionales.precio.';

-- Relleno de filas viejas (si las hubiera) con el precio vigente del catalogo
update adicionales_reserva ar
   set precio_unitario = a.precio
  from adicionales a
 where a.id = ar.adicionales_id
   and ar.precio_unitario is null;


-- --------------------------------------------------------------------------------------------
-- 5. Catalogo de estados de reserva
-- --------------------------------------------------------------------------------------------
-- La tabla `estado` estaba vacia, y sin una sola fila no se puede insertar ninguna reserva
-- (estado_id es NOT NULL). Los textos importan: reservasRepo.ts los busca por PEDAZO de
-- palabra, sin tildes ('pendiente', 'confirmad'), asi que estos nombres ya funcionan con el
-- codigo que existe.

insert into estado (descripcion) values
  ('Borrador'),
  ('Pendiente de pago'),
  ('Confirmada'),
  ('Cancelada'),
  ('Completada'),
  ('Expirada')
on conflict (descripcion) do nothing;


-- Resuelve un estado por pedazo de texto, sin tildes y sin importar mayusculas.
-- Se usa adentro de las funciones de pago para no clavar ids a mano (los ids dependen del
-- orden en que se inserto el catalogo y cambian entre entornos).
create or replace function fn_estado_id(p_texto text)
returns int as $$
  select id from estado
   where unaccent(lower(descripcion)) like '%' || unaccent(lower(p_texto)) || '%'
   order by id
   limit 1;
$$ language sql stable;

-- --------------------------------------------------------------------------------------------
-- 6. Anti doble-reserva: un domo no puede estar en dos estadias que se pisan
-- --------------------------------------------------------------------------------------------
-- Se hace con TRIGGER y no con una restriccion EXCLUDE porque hay que mirar el estado de la
-- otra reserva (una cancelada o expirada NO bloquea el cupo), y eso vive en otra tabla:
-- una restriccion EXCLUDE no puede consultar `estado`.
--
-- LIMITE CONOCIDO: entre que el trigger consulta y la fila se inserta hay una ventana minima
-- en la que dos reservas simultaneas podrian colarse. Con el volumen de un glamping es
-- despreciable; si algun dia deja de serlo, la salida es denormalizar el estado a una columna
-- booleana en `reservas` y pasar a una restriccion EXCLUDE de verdad.

create or replace function fn_reservas_sin_solape()
returns trigger as $$
declare
  v_choque record;
  v_hasta_nueva date;
begin
  -- Sin domo asignado todavia no hay nada que bloquear
  if new.domo_id is null then
    return new;
  end if;

  v_hasta_nueva := coalesce(new.fecha_fin_reserva, new.fecha_reservada + 1);

  select r.id, r.fecha_reservada, r.fecha_fin_reserva
    into v_choque
    from reservas r
    join estado e on e.id = r.estado_id
   where r.domo_id = new.domo_id
     and r.id is distinct from new.id
     -- una reserva muerta no ocupa el domo
     and unaccent(lower(e.descripcion)) !~ '(cancel|expir)'
     -- rangos [check-in, check-out) que se tocan
     and daterange(r.fecha_reservada, coalesce(r.fecha_fin_reserva, r.fecha_reservada + 1), '[)')
      && daterange(new.fecha_reservada, v_hasta_nueva, '[)')
   limit 1;

  if found then
    raise exception
      'El domo % ya esta ocupado del % al % por la reserva %',
      new.domo_id, v_choque.fecha_reservada, v_choque.fecha_fin_reserva, v_choque.id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_reservas_sin_solape on reservas;
create trigger trg_reservas_sin_solape
  before insert or update of domo_id, fecha_reservada, fecha_fin_reserva, estado_id on reservas
  for each row execute function fn_reservas_sin_solape();


-- --------------------------------------------------------------------------------------------
-- Verificacion
-- --------------------------------------------------------------------------------------------
select 'estado' as tabla, count(*) as filas from estado
union all select 'reservas', count(*) from reservas
union all select 'adicionales_reserva', count(*) from adicionales_reserva;

select column_name, data_type, is_nullable
  from information_schema.columns
 where table_name = 'reservas'
 order by ordinal_position;
