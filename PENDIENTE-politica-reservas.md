# ✅ RESUELTO (2026-09-13) — política de reservas y cancelaciones

> Este archivo quedaba abierto esperando el texto oficial de la política. Daniel lo pasó el
> mismo día (las dos piezas del glamping: "TÉRMINOS Y CONDICIONES DE TU RESERVA" e "Información
> importante antes de reservar") y ya está implementado. **Se puede borrar.** Queda un rato por
> si alguien viene siguiendo el hilo de lo que estaba pendiente.

## Cómo quedó

Las políticas viven en la tabla **`politicas`** de Supabase — no en el código y no en el prompt.
Daniel lo pidió así para poder cambiarlas sin tocar código, y además era lo técnicamente
correcto: el pipeline descarta cualquier mensaje del bot con una cifra de dinero que no haya
salido de una herramienta (ver `montosEn` en `src/core/pipeline/runTurn.ts`), así que una
política con montos ($ 100.000, $ 150.000, $ 40.000) escrita en el prompt no habría podido
llegarle nunca al cliente.

- `sql/politicas.sql` — crea la tabla y siembra las 4 entradas (`terminos_reserva`,
  `antes_de_reservar`, `saldo_pendiente`, `cambios_corta`). Se corre en el SQL Editor de
  Supabase y se puede correr más de una vez.
- `src/core/db/politicasRepo.ts` — lectura con cache de 30 s (mismo molde que `faqRepo`).
- `src/agentes/ventas/herramientas/politicas.ts` — la herramienta `consultar_politicas`, con
  `permitirRedaccion: false` para que el texto salga EXACTO.
- El mensaje del link de pago (`herramientas/pago.ts`), el de "ya pagué" y el aviso automático
  (`core/pipeline/avisarPago.ts`) ya no dicen "según las condiciones del plan": traen la
  política real desde la tabla.
- Se puede editar desde el panel de administración: `GET/PUT/DELETE /admin/api/politicas`.
- Prueba: `npm run prueba:politicas` (6 casos).

## Lo que quedó anotado para revisar con el equipo

- **Mascotas.** La pieza oficial deja ver que se admiten ("si traes tu mascota, debes controlar
  los ladridos"), pero no dice si hay costo, límite de tamaño o de cantidad, ni si pueden entrar
  al domo. El prompt base tiene instrucción explícita de NO deducir eso y derivarlo al equipo.
- **Check-in de los viernes.** La política oficial dice hasta las 9:00 p. m. los viernes y hasta
  las 8:00 p. m. de sábado a jueves. Antes el bot decía 8:00 p. m. para todos los días; ya quedó
  corregido en `src/agentes/_base.md`.
- **El comprobante.** El mensaje del link terminaba con "mándame el comprobante", que
  contradecía tanto el prompt ("nunca le pidas el comprobante") como los chequeos automáticos a
  Bold. Se cambió por "Apenas pagues yo lo veo de mi lado y te confirmo la reserva por acá".
