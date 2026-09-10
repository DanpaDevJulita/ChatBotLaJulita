-- ============================================================================================
-- PARTE 12 — aprendizaje asistido: correcciones del equipo + sesiones de identificación
-- (2026-09-08)
--
-- `correcciones`: cada fila es algo que el equipo le enseñó al bot por WhatsApp con /corrige.
-- Se le inyectan al prompt en CADA turno, así que aplican para todos los clientes desde el
-- mensaje siguiente, sin tocar código ni volver a desplegar.
--
-- `sesiones_equipo`: cuando alguien del equipo se identifica con el código secreto + usuario y
-- clave, su número queda habilitado por unas horas. Así puede corregir al bot desde cualquier
-- teléfono sin volver a mandar la clave en cada mensaje.
--
-- Correr en Supabase → SQL Editor → pegar → Run.
-- ============================================================================================

create table if not exists correcciones (
  id serial primary key,
  texto text not null,
  -- Quién la escribió y por dónde, para poder auditar quién enseñó qué.
  autor text not null,
  canal text not null default 'whatsapp',
  -- Se desactivan en vez de borrarse: queda el historial de lo que se le enseñó.
  activa boolean not null default true,
  creado_en timestamptz not null default now()
);
create index if not exists correcciones_activa_idx on correcciones (activa, creado_en);

create table if not exists sesiones_equipo (
  canal text not null,
  external_id text not null,
  usuario text not null,
  expira_en timestamptz not null,
  creado_en timestamptz not null default now(),
  primary key (canal, external_id)
);
create index if not exists sesiones_equipo_expira_idx on sesiones_equipo (expira_en);

select 'correcciones' as tabla, count(*) from correcciones
union all select 'sesiones_equipo', count(*) from sesiones_equipo;
