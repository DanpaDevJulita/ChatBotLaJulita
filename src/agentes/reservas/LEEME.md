# Bot de Reservas — sin construir todavía

Esta carpeta está **reservada** (juego de palabras aparte) para el bot de Reservas. Hoy el tema
`reservas` lo atiende el bot de **ventas** (ver `src/agentes/ventas/agente.ts`, campo `atiende`).

El diseño está en `prompt-de-diseno.md`. Ojo: describe herramientas que **no existen**
(`verificarDisponibilidadFechas`, `mostrarPaquetesGlamping`) — parte de eso ya está resuelto de
otra forma en las herramientas de ventas (`consultar_planes` con cupo real de LobbyPMS y
`consultar_fechas_alternativas`), así que hay que revisar ese diseño antes de seguirlo al pie de
la letra.

Para construirlo: seguí los pasos de `../LEEME.md` ("Crear un bot nuevo") y acordate de sacar
`"reservas"` del `atiende` de ventas.
