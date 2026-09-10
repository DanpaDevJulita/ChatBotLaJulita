-- ============================================================================================
-- PARTE 13 — bloqueo temporal de cupo (2026-09-09)
--
-- Cuando el cliente ya eligió un plan y dio sus datos (registrar_datos_reserva), se marca la
-- combinación domo+capacidad+fecha como "bloqueada" por unos minutos, para que el bot no le
-- ofrezca esa misma disponibilidad a OTRO cliente mientras este decide pagar. Si pasa el tiempo
-- (BLOQUEO_MINUTOS en el .env, hoy 10) y nadie confirmó el pago, se libera sola y se avisa al
-- cliente que corre el riesgo de perder el cupo.
--
-- OJO — esto es un bloqueo interno del BOT, no de LobbyPMS: evita que el bot le prometa a dos
-- clientes el mismo cupo, pero NO evita que un vendedor reserve ese mismo domo directo en
-- LobbyPMS al mismo tiempo. Eso se resuelve más adelante conectando la API oficial de LobbyPMS
-- (ver src/core/integrations/lobbypms.ts).
--
-- Correr en Supabase → SQL Editor → pegar → Run.
-- ============================================================================================

create table if not exists bloqueos_temporales (
  id serial primary key,
  canal text not null,
  external_id text not null,
  plan_id integer references planes(id),
  -- "chalet" | "clasico" | "deluxe" (ver clasesDePlan en src/core/tools/catalogo.ts)
  clase_domo text not null,
  -- 2 o 4 — separa "clasico" en romantic(2p)/familiar(4p), como hace LobbyPMS.
  capacidad integer not null,
  fecha_entrada date not null,
  noches integer not null default 1,
  -- pendiente: esperando pago | confirmado: el equipo verificó el pago | liberado: venció el
  -- tiempo (o se liberó a mano) sin confirmar.
  estado text not null default 'pendiente' check (estado in ('pendiente', 'confirmado', 'liberado')),
  creado_en timestamptz not null default now(),
  expira_en timestamptz not null,
  -- para no mandar dos veces el aviso de "se venció tu cupo" si el job corre más de una vez.
  avisado boolean not null default false
);

create index if not exists bloqueos_temporales_activos_idx
  on bloqueos_temporales (clase_domo, capacidad, fecha_entrada, estado);
create index if not exists bloqueos_temporales_conversacion_idx
  on bloqueos_temporales (canal, external_id, estado);

select 'bloqueos_temporales' as tabla, count(*) from bloqueos_temporales;
