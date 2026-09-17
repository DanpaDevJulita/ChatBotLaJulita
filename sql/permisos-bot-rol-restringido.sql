-- =====================================================================
-- Rol restringido para el bot de La Julita
-- =====================================================================
-- Problema que resuelve: el bot se conecta con SUPABASE_SERVICE_ROLE_KEY,
-- que tiene el atributo BYPASSRLS y por lo tanto acceso total de lectura y
-- escritura a TODAS las tablas del proyecto, incluidas las del panel
-- (users, roles, permisos). Ninguna politica de seguridad lo frena mientras
-- use esa llave.
--
-- Este script crea un rol `bot_lajulita` con exactamente los permisos que el
-- bot necesita y nada mas. Despues hay que hacer que el bot se conecte con
-- ese rol (ver permisos-bot-INSTRUCCIONES.md).
--
-- Se puede correr varias veces sin romper nada.
-- Donde: Supabase -> SQL Editor -> pegar y ejecutar.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. El rol, y el permiso para que PostgREST pueda asumirlo
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bot_lajulita') then
    create role bot_lajulita nologin noinherit;
  end if;
end $$;

grant bot_lajulita to authenticator;
grant usage on schema public to bot_lajulita;

-- ---------------------------------------------------------------------
-- 2. Partimos de cero: el rol no tiene nada hasta que se lo demos
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from bot_lajulita;
revoke all on all sequences in schema public from bot_lajulita;
revoke all on all functions in schema public from bot_lajulita;
alter default privileges in schema public revoke all on tables from bot_lajulita;

-- ---------------------------------------------------------------------
-- 3. Catalogo y consulta: SOLO LECTURA
--    Es lo que el bot necesita para informarle al cliente.
--    Ojo: el bot conversacional NUNCA escribe estas tablas. Las escrituras
--    que hay en el codigo salen todas de web/admin/routes.ts, el panel viejo
--    embebido en el bot, que ahora reemplaza el panel de Laravel.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'planes', 'domos', 'clase_domo', 'adicionales', 'tipo_adicional',
    'recargos', 'politicas', 'faq', 'configuracion', 'promociones',
    'plantillas_carousel', 'fechas_bloqueadas', 'tipo_documento',
    'estado', 'conversaciones', 'v_estado_cuenta'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('grant select on public.%I to bot_lajulita', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Operacion del bot: lectura y escritura acotada
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  permisos constant text[][] := array[
    -- tabla                  privilegios
    ['mensajes',              'select, insert'],
    ['acompanantes',          'select, insert'],
    ['reservas',              'select, insert'],
    ['promociones_envios',    'select, insert'],
    ['clientes',              'select, insert, update'],
    ['estado_conversacion',   'select, insert, update'],
    ['bloqueos_temporales',   'select, insert, update'],
    ['correcciones',          'select, insert, update'],
    ['alertas_tecnicas',      'select, insert, update'],
    ['pagos',                 'select, update'],
    -- El bot abre y actualiza tickets de fallas tecnicas, pero nunca los borra
    -- ni los cierra: eso lo hacen las personas desde el panel.
    ['tickets',               'select, insert, update'],
    -- cerrarSesion() borra filas, por eso lleva delete
    ['sesiones_equipo',       'select, insert, update, delete']
    -- OJO: `users` (usuarios del panel) NO va en esta lista a propósito: un grant sobre la tabla
    -- completa le daría al bot las contraseñas. Su grant es POR COLUMNA, más abajo (sección 4b).
  ];
  i int;
begin
  for i in 1 .. array_length(permisos, 1) loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = permisos[i][1]) then
      execute format('grant %s on public.%I to bot_lajulita',
                     permisos[i][2], permisos[i][1]);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4b. [2026-09-16] Usuarios del panel autorizados a corregir el bot
--     El bot compara el remitente con `celular_clave` y mira la marca
--     `bot_puede_corregir` (ver sql/users-bot-corrige.sql). Solo esas
--     columnas: nunca email, password ni remember_token.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'users' and column_name = 'bot_puede_corregir') then
    grant select (id, name, activo, celular_clave, bot_puede_corregir) on public.users to bot_lajulita;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Secuencias de las tablas donde el bot inserta
--    Sin esto, un insert en una tabla con id serial falla.
-- ---------------------------------------------------------------------
do $$
declare t text; c text; s text;
begin
  foreach t in array array[
    'mensajes', 'acompanantes', 'reservas', 'promociones_envios', 'clientes',
    'estado_conversacion', 'bloqueos_temporales', 'correcciones',
    'alertas_tecnicas', 'sesiones_equipo', 'tickets'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      for c in select column_name from information_schema.columns
               where table_schema = 'public' and table_name = t loop
        s := pg_get_serial_sequence('public.' || quote_ident(t), c);
        if s is not null then
          execute format('grant usage, select on sequence %s to bot_lajulita', s);
        end if;
      end loop;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. Funciones de pago que el bot invoca por RPC
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as firma
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fn_crear_pago_pendiente', 'fn_registrar_pago_aprobado')
  loop
    execute format('grant execute on function %s to bot_lajulita', f.firma);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Tablas del panel: cerradas para el bot y para cualquier llave publica
--    RLS sin politicas = nadie entra, salvo los roles con BYPASSRLS
--    (el postgres con el que se conecta Laravel sigue entrando sin problema).
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'roles', 'permisos', 'rol_permiso', 'sessions',
    'password_reset_tokens', 'cache', 'cache_locks', 'jobs', 'job_batches',
    'failed_jobs', 'migrations', 'bitacora_cambios'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t
                 and table_type = 'BASE TABLE') then
      execute format('revoke all on public.%I from bot_lajulita', t);
      execute format('revoke all on public.%I from anon, authenticated', t);
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 8. RLS de `tickets`
--    La tabla se creo con Row Level Security activado (para que las llaves
--    publicas anon/authenticated no la alcancen). Con RLS y sin politicas
--    NADIE entra salvo los roles con BYPASSRLS, asi que el rol del bot
--    necesita su propia politica o no podria abrir tickets.
--    Postgres evalua primero los GRANT y despues la politica: el bot sigue
--    sin poder borrar, porque ese permiso nunca se le dio.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'tickets') then
    execute 'alter table public.tickets enable row level security';
    execute 'drop policy if exists tickets_bot on public.tickets';
    execute 'create policy tickets_bot on public.tickets for all to bot_lajulita using (true) with check (true)';
  end if;
end $$;

commit;

-- =====================================================================
-- Verificacion: que quedo con permiso el bot
-- =====================================================================
select table_name as tabla,
       string_agg(distinct privilege_type, ', ' order by privilege_type) as permisos
from information_schema.role_table_grants
where grantee = 'bot_lajulita' and table_schema = 'public'
group by table_name
order by table_name;

-- Esta consulta debe volver VACIA. Si devuelve filas, el bot todavia
-- alcanza tablas del panel.
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'bot_lajulita'
  and table_name in ('users', 'roles', 'permisos', 'rol_permiso',
                     'bitacora_cambios', 'sessions');
