-- ============================================================
-- Glamping La Julita - Chatbot
-- RECARGOS: lo que se cobra APARTE del plan (niños y mascotas)
-- ============================================================
-- [2026-09-14] Pedido de Daniel: "para el tema de niños y mascotas adicionales sí se debe crear
-- la tabla donde se pongan con su respectivo valor, para que cuando el plan salga eso el bot tome
-- de las tablas los precios".
--
-- El problema que resuelve: hoy esos valores están escritos A MANO dentro del texto libre de
-- algunos planes (por ejemplo ">3 años $50.000" y ">5 años $70.000" en el PLAN FAMILIAR). Como no
-- existen en ninguna columna, el bot NO los puede verificar — y por seguridad borra esas líneas
-- antes de mandarle el mensaje al cliente (ver resolverPreciosEnDescripcion en
-- src/agentes/ventas/herramientas/planes.ts). Resultado: el cliente nunca se entera del recargo
-- por un niño, y se entera al llegar, que es la peor forma de enterarse.
--
-- Con esta tabla el dato pasa a ser REAL: el equipo lo edita en un solo lugar, el bot lo lee de
-- acá y lo puede decir con total confianza (y la verificación anti-precios-inventados lo deja
-- pasar, porque salió de la base).
--
-- Se puede correr varias veces sin romper nada.
-- ============================================================

create table if not exists recargos (
  id serial primary key,

  -- Qué clase de recargo es. Se deja como texto con lista cerrada para poder sumar tipos nuevos
  -- (ej. 'persona_adicional') sin migrar nada más.
  tipo text not null check (tipo in ('nino', 'mascota')),

  -- Cómo se le nombra al cliente: "Niño de 3 a 5 años", "Mascota pequeña (hasta 10 kg)".
  nombre text not null,

  -- Condiciones o aclaraciones: "por noche", "máximo 1 por domo", "debe venir con guacal".
  descripcion text,

  -- El valor. Es la única fuente de verdad: si acá dice 50000, el bot dice $50.000.
  precio numeric(12, 2) not null,

  -- Solo para 'nino': el rango de edad al que aplica este valor. Sirve para que el bot conteste
  -- "¿cuánto paga un niño de 4 años?" sin que nadie tenga que interpretar nada.
  edad_min integer,
  edad_max integer,

  -- NULL = aplica a TODOS los planes (lo normal). Con un plan puntual, solo a ese — por si algún
  -- plan cobra distinto.
  plan_id integer references planes (id) on delete cascade,

  activo boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table recargos is
  'Valores que se cobran APARTE del plan: niños por rango de edad y mascotas. El bot los lee de acá — nunca del texto libre de la descripción de un plan, que no se puede verificar.';
comment on column recargos.tipo is 'nino | mascota';
comment on column recargos.plan_id is 'NULL = aplica a todos los planes. Con un plan puntual, solo a ese.';
comment on column recargos.edad_min is 'Solo para tipo=nino. Edad mínima (inclusive) del rango.';
comment on column recargos.edad_max is 'Solo para tipo=nino. Edad máxima (inclusive). NULL = sin tope.';

create index if not exists recargos_tipo_activo_idx on recargos (tipo, activo);

-- ============================================================
-- VALORES INICIALES
-- ============================================================
-- Los de NIÑOS salen de lo que hoy está escrito a mano en la descripción del PLAN FAMILIAR
-- 3 PERSONAS (id 30): ">3 años $50.000" y ">5 años $70.000". Se cargan como rangos explícitos
-- porque ">3" y ">5" juntos son ambiguos (un niño de 6 años entra en los dos).
--
-- ⚠️ REVISAR CON EL EQUIPO antes de darlos por buenos: (a) confirmar los rangos de edad exactos,
-- (b) confirmar si un menor de 3 años no paga, y (c) si estos valores son iguales para TODOS los
-- planes o solo para los familiares (si es lo segundo, hay que ponerles plan_id).
insert into recargos (tipo, nombre, descripcion, precio, edad_min, edad_max)
select 'nino', 'Niño de 3 a 5 años', 'Valor por noche, adicional al plan.', 50000, 3, 5
 where not exists (select 1 from recargos where tipo = 'nino' and edad_min = 3);

insert into recargos (tipo, nombre, descripcion, precio, edad_min, edad_max)
select 'nino', 'Niño de 6 años en adelante', 'Valor por noche, adicional al plan.', 70000, 6, null
 where not exists (select 1 from recargos where tipo = 'nino' and edad_min = 6);

-- Las MASCOTAS quedan pendientes a propósito: el equipo todavía no ha definido costo, tamaño
-- permitido ni cuántas por domo (está en la lista de pendientes desde hace días). Cuando lo
-- definan, se carga así — mientras tanto el bot dice que lo confirma con el equipo, que en este
-- caso SÍ es la respuesta correcta, porque el dato no existe todavía.
--
-- insert into recargos (tipo, nombre, descripcion, precio) values
--   ('mascota', 'Mascota pequeña (hasta X kg)', 'Valor por estadía. Máximo N por domo.', 00000);

-- ============================================================
-- Verificación:
-- select tipo, nombre, precio, edad_min, edad_max, activo from recargos order by tipo, edad_min;
-- ============================================================
