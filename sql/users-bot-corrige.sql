-- ============================================================================================
-- USUARIOS DEL PANEL AUTORIZADOS A CORREGIR EL BOT  (2026-09-16)
--
-- Quién puede darle órdenes al bot por WhatsApp se marca en la tabla `users` del PANEL (la de
-- los vendedores/administradores que inician sesión en LaJulitaWeb), no en una tabla aparte.
-- Decisión de Daniel: "en la tabla de usuarios de la interfaz gráfica se marca qué usuarios
-- están autorizados a corregir el bot, y ahí se registra el celular al crear el usuario".
--
-- Se agregan tres columnas:
--   celular            → el WhatsApp de la persona, como lo escriban (con o sin +57).
--   celular_clave      → últimos 10 dígitos, calculada sola: es lo que el bot compara con el
--                        remitente (igual que en el resto del bot). Única, así "+57300..." y
--                        "300..." no pueden ser dos usuarios distintos.
--   bot_puede_corregir → la marca. Con ella (y `activo` = true) el número puede:
--                          - reportar fallas: texto o audio que empiece con "corrige" → ticket
--                          - enseñar reglas: /aprende, /correcciones, /borra, /confirmar, /resuelto
--
-- Un usuario INHABILITADO en el panel (`activo` = false) pierde el permiso automáticamente,
-- aunque la marca siga puesta: es la misma llave que le quita el acceso al panel.
--
-- El bot solo LEE, y solo ESTAS columnas (grant por columna): nunca ve email, contraseña ni
-- remember_token. Las variables OWNER_WHATSAPP_NUMBERS / REPORTE_FALLAS_NUMBERS del .env siguen
-- valiendo como respaldo.
--
-- Correr en Supabase → SQL Editor → pegar → Run. Es idempotente. En el panel Laravel va la
-- migración equivalente (ver panel-parches/2026-09-16-bot-corrige/) para que el esquema quede
-- versionado allá también — correr una sola de las dos: las dos hacen lo mismo.
-- ============================================================================================

alter table users add column if not exists celular text;
alter table users add column if not exists bot_puede_corregir boolean not null default false;

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'users' and column_name = 'celular_clave') then
    alter table users add column celular_clave text
      generated always as (nullif(right(regexp_replace(coalesce(celular, ''), '\D', '', 'g'), 10), '')) stored;
  end if;
end $$;

-- Único solo cuando hay celular: los usuarios sin celular (null) no chocan entre sí.
create unique index if not exists users_celular_clave_uidx on users (celular_clave) where celular_clave is not null;
create index if not exists users_bot_corrige_idx on users (bot_puede_corregir) where bot_puede_corregir;

-- Lo único de `users` que el bot puede leer. Sin grant sobre la tabla completa a propósito.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'bot_lajulita') then
    grant select (id, name, activo, celular_clave, bot_puede_corregir) on public.users to bot_lajulita;
  end if;
end $$;

-- Ejemplo para marcar a alguien a mano mientras el panel no tenga el campo:
-- update users set celular = '+573001234567', bot_puede_corregir = true where email = 'daniel@...';

select id, name, celular, celular_clave, bot_puede_corregir, activo from users order by id;
