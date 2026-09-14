# Bot de Reservas

[2026-09-14] Ya está construido — ver `agente.ts` y `prompt.md`. Se ocupa de un solo tema
(`atiende: ["reservas"]`): confirmar cupo real, tomar los datos de cada huésped con
`registrar_datos_reserva` y dejar armado el primer paso del cobro (`preguntar_forma_de_pago`,
que es del bot de **pagos** pero tiene que correr en el mismo turno — ver el comentario de
`agenteDueno` en `src/core/tools/types.ts` para el porqué).

Sus herramientas viven todas en `src/agentes/ventas/herramientas/` (no se duplicaron acá, misma
convención de siempre — ver "Herramientas que usan dos bots" en `../LEEME.md`): este `agente.ts`
solo importa las que le tocan.

Antes de este cambio, el tema `reservas` lo atendía el bot de **ventas**. El diseño viejo que
había acá (`prompt-de-diseno.md`) describía herramientas que nunca se construyeron con esos
nombres (`verificarDisponibilidadFechas`, `mostrarPaquetesGlamping`) — lo real terminó siendo
`consultar_planes` (con cupo de LobbyPMS) y `consultar_fechas_alternativas`. Se deja el archivo
viejo como referencia histórica, pero el diseño vigente es el `prompt.md` de esta carpeta.
