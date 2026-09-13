# PENDIENTE — volver sobre el arreglo del bug de precios

> **Daniel pidió (2026-09-11): cuando él diga "podemos corregir" (o algo así), recordarle este
> punto y revisar juntos cómo arreglar esto mejor.** Este archivo existe para eso: si estás
> leyendo el repo y Daniel menciona que hay tiempo para corregir cosas, esto es lo que quedó
> pendiente.

## Qué pasaba

El bot cotizaba un precio viejo aunque el equipo ya lo hubiera cambiado en Supabase. La causa
real: **el precio está escrito dos veces**. Por un lado las columnas `precio_entre_semana`,
`precio_fin_de_semana` y `precio_fin_de_semana_puente` (la fuente real). Por otro, **a mano,
como texto suelto, dentro de `planes.descripcion`**. Al cambiar la columna, el texto de la
descripción quedaba viejo, viajaba igual hacia el modelo (en el `result` de la herramienta) y
era el que terminaba saliendo al cliente.

## Qué se hizo (funciona, pero es un parche)

1. `planes.ts` — al traer los planes de la base se descarta cualquier línea de la descripción
   que parezca un precio (`quitarLineasDePrecio`). Se limpia **en el origen**, así ni el texto
   ni los datos crudos que ve el modelo pueden traer el precio viejo.
2. `runTurn.ts` — si el modelo contesta con texto libre que menciona plata sin haber llamado
   ninguna herramienta en ese hop, se descarta la respuesta y se fuerza `consultar_planes`.
3. `runTurn.ts` — la verificación anti-alucinación ahora corre siempre que el texto lo haya
   escrito el modelo (antes se desactivaba sola cuando la herramienta no devolvía datos: con
   Supabase caído el modelo podía mandar cualquier cifra sin freno).

Pruebas: `npm run prueba:precio` (7 escenarios adversariales) y `npm run prueba:pago` (5).
Ambas pasaban al cerrar el 2026-09-11.

## Por qué NO es la solución definitiva

- **La causa raíz sigue viva.** 5 planes (ids 3, 28, 30, 31, 32) todavía tienen precios escritos
  a mano en `descripcion`. El código los ignora, pero el dato sucio sigue ahí y confunde a
  cualquiera que mire la tabla. El id 28 dice "$339.000" y su columna está en $1.000.
- **El fallback es feo.** Cuando el modelo insiste con un precio no verificado, al cliente le
  llega el texto CRUDO de la herramienta (la plantilla completa del plan, sin redactar). Es
  correcto pero se nota que es un bot.
- **El filtro es por regex.** Descarta líneas con `$` seguido de números. Si mañana alguien
  escribe "590.000 entre semana" (sin `$`), se cuela. Hoy no pasa — se verificó plan por plan —
  pero es frágil.
- **Falta una regla de negocio explícita:** la descripción debería ser solo contenido (qué
  incluye, horarios, políticas) y nunca precios.

## Ideas para cuando se retome

1. Limpiar de una vez las 5 descripciones en Supabase y dejar el aviso en el panel de
   administración: "no escribas precios acá, salen de las columnas de precio".
2. Validar al guardar desde el panel: si la descripción trae un `$` con números, avisar.
3. Reemplazar el volcado de plantilla por un reintento de redacción acotado (una oportunidad
   más para el modelo, con instrucción explícita de usar SOLO la cifra de la herramienta) y
   recién si vuelve a fallar, mandar el texto crudo.
4. Evaluar que `descripcion` deje de viajar entera en el `result` que ve el modelo: mandarle
   solo los campos que necesita para redactar.
