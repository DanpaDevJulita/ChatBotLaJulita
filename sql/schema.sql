-- Esquema de Supabase para el bot y el panel de administración de La Julita.
--
-- Construido el 2026-09-04, tabla por tabla, con el diseño que dio el equipo directamente.
-- Cada sección (PARTE N) se agrega a este archivo solo después de probarse en local y de
-- correr de verdad en el proyecto de Supabase real ("Bot La Julita") — este archivo refleja
-- exactamente lo que ya existe en Supabase, ni más ni menos. A medida que se creen tablas
-- nuevas o se le agreguen cosas a las que ya existen, se sigue alimentando aquí con una PARTE
-- nueva.
--
-- Convención: id serial (autoincremental) en todas las tablas, no uuid — decisión explícita
-- del equipo.
--
-- Cómo usarlo: entra a tu proyecto en supabase.com → menú "SQL Editor" → "New query",
-- pega la parte nueva y dale "Run" (todo usa "if not exists"/"or replace", se puede correr
-- varias veces sin problema).

create extension if not exists "pgcrypto";

-- ============================================================================================
-- PARTE 1 — domos (confirmada y ya corrida en Supabase el 2026-09-04)
-- ============================================================================================

-- Clase de domo: la categoría/tipo general (ej. "clásico", "premium"...).
create table if not exists clase_domo (
  id serial primary key,
  nombre text not null unique
);

-- Domos: cada fila es un domo/unidad física concreta.
--   clase         -> referencia a clase_domo(id).
--   opcion        -> texto libre que describe para quién es esa unidad
--                    (ej. "familia", "pareja", "individual", "no mascotas").
--   capacidad_max -> huéspedes máximos que admite ese domo.
create table if not exists domos (
  id serial primary key,
  clase int not null references clase_domo(id),
  opcion text,
  capacidad_max int not null
);
create index if not exists domos_clase_idx on domos (clase);

-- ============================================================================================
-- PARTE 2 — planes (confirmada y ya corrida en Supabase el 2026-09-04)
-- ============================================================================================

-- domos_id es un arreglo (int[]) con los ids de los domos que se podrían usar en ese plan —
-- a pedido explícito del usuario, en vez de una tabla intermedia (más normalizado pero más
-- pasos para consultar). Una foreign key normal no puede validar cada elemento de un arreglo,
-- así que esta columna por sí sola NO garantiza que esos ids existan de verdad en `domos` —
-- pero la PARTE 7 (más abajo) agrega triggers que sí hacen cumplir esa relación en la base de
-- datos misma (no solo en el código del bot).
create table if not exists planes (
  id serial primary key,
  nombre text not null,
  descripcion text,
  precio_entre_semana numeric,
  precio_fin_de_semana numeric,
  precio_fin_de_semana_puente numeric,
  capacidad int,
  domos_id int[],
  activo boolean not null default true
);
-- Índice GIN: para que "qué planes usan el domo X" (domos_id @> array[X]) sea rápido.
create index if not exists planes_domos_id_idx on planes using gin (domos_id);

-- ============================================================================================
-- PARTE 3 — tipo_adicional + adicionales (confirmada y ya corrida en Supabase el 2026-09-04)
-- ============================================================================================

-- Tipo de adicional: categoría del adicional (ej. "Alimentación", "Experiencia", "Transporte").
create table if not exists tipo_adicional (
  id serial primary key,
  nombre text not null unique
);

-- Adicionales: extras que se pueden sumar a una reserva/plan.
--   estado -> booleano activo/inactivo (igual patrón que planes.activo), confirmado por el
--             usuario — NO referencia la tabla `estado(id, descripcion)` que aparece más
--             adelante en su lista (esa es solo para reservas.estado_id).
create table if not exists adicionales (
  id serial primary key,
  nombre text not null,
  descripcion text,
  precio numeric,
  tipo_adicional_id int not null references tipo_adicional(id),
  estado boolean not null default true
);
create index if not exists adicionales_tipo_adicional_id_idx on adicionales (tipo_adicional_id);

-- ============================================================================================
-- PARTE 4 — tipo_documento + clientes (confirmada y ya corrida en Supabase el 2026-09-04)
-- ============================================================================================

-- Tipo de documento: catálogo con su seudonimo/sigla (ej. id=1, nombre="Cedula", seudonimo="CC").
create table if not exists tipo_documento (
  id serial primary key,
  nombre text not null unique,
  seudonimo text not null unique
);

-- Clientes: quien hace la reserva.
--   tipo_documento_id -> referencia a tipo_documento(id).
--   Obligatorios (confirmado por el equipo): nombre, numero_documento, celular.
--   Además de lo pedido por el equipo, se agregó un unique(tipo_documento_id, numero_documento)
--   para que no se pueda registrar dos veces el mismo documento como cliente distinto — avisar
--   si en algún momento se prefiere quitar esta restricción.
create table if not exists clientes (
  id serial primary key,
  nombre text not null,
  tipo_documento_id int not null references tipo_documento(id),
  numero_documento text not null,
  celular text not null,
  correo text,
  unique (tipo_documento_id, numero_documento)
);
create index if not exists clientes_tipo_documento_id_idx on clientes (tipo_documento_id);

-- ============================================================================================
-- PARTE 5 — estado + reservas (confirmada y ya corrida en Supabase el 2026-09-04)
-- ============================================================================================

-- Estado: catálogo de estados posibles de una reserva (ej. "Pendiente", "Confirmada",
-- "Cancelada", "Completada") -- referenciada por reservas.estado_id.
create table if not exists estado (
  id serial primary key,
  descripcion text not null unique
);

-- Reservas.
--   Nota: se corrigió el nombre de columna "cleinte_id" (typo en la lista original del equipo)
--   a "cliente_id".
--   Interpretación de los campos de dinero (avisar si no es la lógica correcta del negocio):
--     valor_total -> valor base de la reserva según el plan/tarifa aplicada.
--     total       -> valor final a pagar (valor_total + adicionales, descuentos, etc.).
--     anticipo    -> lo que el cliente ya pagó como adelanto.
--     saldo       -> lo que falta por pagar (debería ser total - anticipo).
create table if not exists reservas (
  id serial primary key,
  cliente_id int not null references clientes(id),
  domo_id int not null references domos(id),
  fecha_reservada date not null,
  numero_huespedes int not null,
  valor_total numeric,
  plan_id int not null references planes(id),
  anticipo numeric,
  saldo numeric,
  total numeric,
  estado_id int not null references estado(id),
  fecha_reserva timestamptz not null default now()
);
create index if not exists reservas_cliente_id_idx on reservas (cliente_id);
create index if not exists reservas_domo_id_idx on reservas (domo_id);
create index if not exists reservas_plan_id_idx on reservas (plan_id);
create index if not exists reservas_estado_id_idx on reservas (estado_id);

-- ============================================================================================
-- PARTE 6 — acompanantes (confirmada y ya corrida en Supabase el 2026-09-04)
-- ============================================================================================

-- Nombre de tabla sin ñ (acompanantes, no "acompañantes") -- mismo patrón ASCII usado en el
-- resto del schema, para no tener que entrecomillar el identificador en cada consulta.
-- Obligatorios (confirmado por el equipo): nombre, numero_documento.
-- Además de lo pedido, dos columnas se dejaron NOT NULL por lógica (avisar si se prefiere que
-- sean opcionales):
--   tipo_documento_id -> sin esto, numero_documento no se puede interpretar (qué tipo de
--                        documento es).
--   reserva_id        -> un acompañante siempre pertenece a una reserva específica (es el
--                        motivo de ser de esta tabla).
create table if not exists acompanantes (
  id serial primary key,
  nombre text not null,
  tipo_documento_id int not null references tipo_documento(id),
  numero_documento text not null,
  celular text,
  correo text,
  reserva_id int not null references reservas(id)
);
create index if not exists acompanantes_reserva_id_idx on acompanantes (reserva_id);
create index if not exists acompanantes_tipo_documento_id_idx on acompanantes (tipo_documento_id);

-- ============================================================================================
-- PARTE 7 — relación real planes.domos_id <-> domos.id, vía triggers (ya corrida en Supabase
-- el 2026-09-04)
-- ============================================================================================

-- Una foreign key normal no puede validar elementos de un array, así que esto reemplaza esa
-- validación con dos triggers:
--   1) Al insertar/actualizar un plan, cada id dentro de domos_id debe existir en domos.
--   2) No se puede borrar un domo si algún plan todavía lo tiene en su domos_id (equivalente
--      al "on delete restrict" que tendría una FK normal).
create or replace function planes_validar_domos_id() returns trigger as $$
begin
  if new.domos_id is not null and exists (
    select 1 from unnest(new.domos_id) as d(id)
    where not exists (select 1 from domos where domos.id = d.id)
  ) then
    raise exception 'planes.domos_id contiene un id de domo que no existe en domos: %', new.domos_id;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace trigger planes_domos_id_check
before insert or update of domos_id on planes
for each row execute function planes_validar_domos_id();

create or replace function domos_bloquear_borrado_si_usado() returns trigger as $$
begin
  if exists (select 1 from planes where domos_id @> array[old.id]) then
    raise exception 'no se puede borrar el domo id=% porque esta referenciado en planes.domos_id', old.id;
  end if;
  return old;
end;
$$ language plpgsql;

create or replace trigger domos_bloquear_borrado
before delete on domos
for each row execute function domos_bloquear_borrado_si_usado();

-- ============================================================================================
-- PARTE 8 — adicionales_reserva (confirmada y ya corrida en Supabase el 2026-09-04)
-- ============================================================================================

-- Tabla puente entre reservas y adicionales: qué adicionales quedaron asociados a qué reserva.
--   fecha -> cuándo se agregó el adicional a la reserva (auditoría), no el día en que se
--            disfruta — confirmado por el equipo. Se autocompleta con el momento actual.
-- Nota: no incluye cantidad ni precio_unitario — si se necesita más de una unidad del mismo
-- adicional en la misma reserva, se agrega una fila por unidad. El precio se toma de
-- adicionales.precio al momento de consultar (no queda "congelado" el precio del día de la
-- reserva) — avisar si se prefiere guardar el precio en el momento en vez de leerlo de
-- adicionales cada vez.
create table if not exists adicionales_reserva (
  id serial primary key,
  adicionales_id int not null references adicionales(id),
  reserva_id int not null references reservas(id),
  fecha timestamptz not null default now()
);
create index if not exists adicionales_reserva_reserva_id_idx on adicionales_reserva (reserva_id);
create index if not exists adicionales_reserva_adicionales_id_idx on adicionales_reserva (adicionales_id);

-- ============================================================================================
-- PARTE 9 — mensajes + conversaciones + estado_conversacion + faq (CONFIRMADA — verificada
-- en Supabase el 2026-09-08 con scripts/diagnostico.ts: `mensajes` tenía 24 filas,
-- `estado_conversacion` 1, la vista `conversaciones` respondía y `faq` existía vacía. Antes
-- esta sección decía "SIN CORRER TODAVÍA" y eso ya no era cierto: el comentario viejo hacía
-- perder tiempo buscando un problema de base de datos que no existía.)
-- ============================================================================================

-- Historial de mensajes de cada conversación (todos los canales). id uuid (no serial, a
-- diferencia del resto del schema) porque mensajesRepo.ts espera `id?: string` y usa
-- pgcrypto (ya habilitado arriba) para generarlo.
create table if not exists mensajes (
  id uuid primary key default gen_random_uuid(),
  canal text not null,
  external_id text not null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null,
  agent_name text,
  created_at timestamptz not null default now()
);
-- Para listMensajes(canal, externalId): filtra por canal+external_id y ordena por created_at.
create index if not exists mensajes_conversacion_idx on mensajes (canal, external_id, created_at);

-- Vista con una fila por conversación (el mensaje más reciente de cada una) — la usa
-- listConversaciones() para el monitor del panel de administración ("Conversaciones").
create or replace view conversaciones as
select distinct on (canal, external_id)
  canal,
  external_id,
  content as ultimo_mensaje,
  role as ultimo_role,
  created_at as ultima_actividad
from mensajes
where role in ('user', 'assistant')
order by canal, external_id, created_at desc;

-- Estado del orquestador por conversación (último agente que atendió + resumen a futuro).
-- Clave primaria compuesta (canal, external_id): así setLastAgent() puede hacer upsert sin
-- indicar onConflict explícito (Supabase usa la primary key por default).
create table if not exists estado_conversacion (
  canal text not null,
  external_id text not null,
  last_agent text,
  resumen text,
  updated_at timestamptz not null default now(),
  primary key (canal, external_id)
);

-- Preguntas frecuentes que gestiona el panel de administración. `tema` como primary key
-- porque faqRepo.ts hace upsert/delete usando tema como clave (no un id aparte).
create table if not exists faq (
  tema text primary key,
  pregunta_ejemplo text,
  respuesta text not null,
  updated_at timestamptz not null default now()
);

-- ============================================================================================
-- PARTE 10 — configuracion + fechas_bloqueadas (CONFIRMADA — verificada en Supabase el
-- 2026-09-08 con scripts/diagnostico.ts: las dos tablas responden, pero están VACÍAS. Por eso
-- el bot todavía no sabe los horarios de check-in/check-out: hay que cargar esas dos filas,
-- ver sql/configuracion-horarios.sql.)
-- ============================================================================================

-- Configuración general clave/valor (hoy solo horarios de check-in/check-out).
create table if not exists configuracion (
  clave text primary key,
  valor text not null,
  updated_at timestamptz not null default now()
);

-- Fechas bloqueadas / no disponibles para reservar.
create table if not exists fechas_bloqueadas (
  id uuid primary key default gen_random_uuid(),
  fecha date not null unique,
  motivo text
);
