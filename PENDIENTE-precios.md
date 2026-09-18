# ✅ RESUELTO (2026-09-17) — el bug de precios en las descripciones

> Este archivo quedaba abierto desde el 2026-09-11 esperando a que hubiera tiempo de arreglarlo
> bien. Daniel dio la indicación el 2026-09-17 y quedó cerrado. **Se puede borrar.** Queda un
> rato por si alguien viene siguiendo el hilo.
>
> La regla vigente, para quien edita el catálogo, está en
> [`REGLA-DESCRIPCIONES-PRECIOS.md`](REGLA-DESCRIPCIONES-PRECIOS.md).

## Qué pasaba

El bot cotizaba un precio viejo aunque el equipo ya lo hubiera cambiado en Supabase. La causa
real: **el precio estaba escrito dos veces**. Por un lado las columnas `precio_entre_semana`,
`precio_fin_de_semana` y `precio_fin_de_semana_puente` (la fuente real). Por otro, a mano, como
texto suelto, dentro de `planes.descripcion`. Al cambiar la columna, el texto quedaba viejo y era
el que terminaba saliendo al cliente.

## Cómo quedó

**La causa raíz ya no existe: el precio vive en un solo lugar.**

1. **El token `$$$$`** (implementado el 2026-09-13). En la descripción, donde iba el número va el
   texto literal `$$$$`, y el bot lo reemplaza por la columna que corresponda según lo que diga
   esa misma línea ("entre semana" / "fin de semana" / "puente o festivo"). Vive en
   `resolverPreciosEnDescripcion`, en `src/agentes/ventas/herramientas/planes.ts`.
2. **La migración de los datos** (2026-09-17). Los 4 planes que faltaban (ids 28, 30, 31, 32) ya
   usan el token. Lo hizo `scripts/migrar-precios-a-token.ts`, que deja respaldo en `_respaldos/`
   y se puede volver a correr.
3. **De paso salieron dos bloques de cifras que duplicaban otras tablas:** los precios del Domo
   Deluxe metidos en la descripción del plan de una persona (el deluxe ya es su propio plan, el
   id 29) y los recargos de niños de los planes familiares (viven en la tabla `recargos`, y el
   bot los responde con `consultar_recargos`).
4. **Se eliminó el filtro que borraba líneas con `$`.** Era el parche de 2026-09-11: descartaba
   cualquier línea que pareciera traer un precio. Ya no protegía de nada (no quedan precios sin
   migrar) y sí hacía daño: borraba montos legítimos que no son tarifa de ningún plan. El caso
   concreto era el PLAN DESCANSO PREMIUM, donde "Cena: dos platos fuertes y dos bebidas (bebidas
   de hasta $10.000)" desaparecía entera y el cliente nunca se enteraba de que la cena venía
   incluida.

## La regla de fondo que fijó Daniel

> "El bot no tiene por qué estar opinando de los precios que pongo en mis tablas, él solo hace
> caso. Los valores de las tablas se deben poner como estén, así parezca descabellado; lo
> verdadero es lo que está en la base de datos."

O sea: si un plan está cargado en $5.000, el bot cotiza $5.000. Las tablas se administran desde el
panel y lo que haya ahí es intencional por definición. Cualquier red de seguridad del código que
borre, redondee o descarte una cifra que vino de la base va en contra de esto.

Lo que **sí** sigue bloqueado, y es otra cosa: que el *modelo* invente una cifra. Toda cifra de
dinero del mensaje final tiene que haber salido de una herramienta en ESE MISMO turno (ver
`montosEn` en `src/core/pipeline/runTurn.ts`). Un número que esté en la descripción sale de la
base, así que pasa sin problema; uno que el modelo recordó de un mensaje anterior, no.

## Pruebas

- `npm run prueba:plantilla-precio` — el token se resuelve bien; un monto escrito a mano llega
  intacto con su línea.
- `npm run prueba:precio` — 7 escenarios adversariales donde el modelo intenta colar un precio
  que no salió de la base. Los 7 pasan.

Las dos suites se actualizaron el 2026-09-17: varios de sus casos comprobaban el comportamiento
viejo (que el bot borrara cifras de la descripción), así que se dieron vuelta para verificar la
regla nueva. La foto de datos `pruebas/datos-reales.ts` también se refrescó contra la base.

## Lo único que quedó anotado

El panel de administración todavía no avisa nada al guardar. Valdría la pena que, si alguien
escribe un `$` con números en una descripción, muestre un recordatorio de que el precio del plan
va como `$$$$` — no para bloquearlo (puede ser un monto legítimo, como el tope de las bebidas),
solo para que no se vuelva a duplicar una tarifa por olvido.
