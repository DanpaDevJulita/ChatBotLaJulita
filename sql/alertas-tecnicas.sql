-- [2026-09-13] Aviso al equipo de DESARROLLO cuando un servicio externo falla (LobbyPMS, Bold,
-- Supabase, etc.) — separado del aviso al equipo de VENTAS que ya existe cuando un CLIENTE pide
-- hablar con una persona (ver escalamiento-humano.sql / notificarEquipo.ts). Este es para que el
-- equipo técnico se entere de una falla de servicio ANTES de que se convierta en un malentendido
-- con un cliente, aunque el bot se las haya arreglado solo en ese momento (ver
-- src/core/pipeline/notificarDesarrollo.ts).
--
-- Guarda, por cada tipo de falla (`clave`, ej: "lobbypms:ip_no_autorizada"), cuándo fue la
-- ÚLTIMA vez que se avisó — así una falla que sigue activa por horas no manda un correo por
-- CADA mensaje de cliente que la pisa, solo uno cada 2 horas (ver ventanaMs en
-- notificarDesarrollo.ts). Es una tabla chica, de solo lectura/escritura para el propio bot.
create table if not exists alertas_tecnicas (
  clave text primary key,
  ultima_vez timestamptz not null default now(),
  veces integer not null default 1,
  detalle text,
  updated_at timestamptz not null default now()
);

comment on table alertas_tecnicas is
  'Throttle de avisos técnicos al equipo de desarrollo (por email) — una fila por tipo de falla. No confundir con estado_conversacion.escalado_en, que es el aviso de VENTAS cuando un cliente pide un humano.';
comment on column alertas_tecnicas.clave is
  'Identifica el TIPO de falla, no la conversación ni el cliente — ej. "lobbypms:ip_no_autorizada", "bold:sin_configurar", "catalogo:clase_domo". Todas las conversaciones que pisen la misma falla comparten esta fila.';
comment on column alertas_tecnicas.veces is
  'Cuántas veces se detectó esta falla desde ultima_vez (o desde que se resolvió y volvió a fallar) — informativo, no cambia el throttle.';
comment on column alertas_tecnicas.detalle is
  'El último mensaje de error visto para esta clave, para que el correo/log traiga contexto real y no solo la clave.';
