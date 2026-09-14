# "Recontacto" — no es un bot de chat, es un envío programado

[2026-09-14] Esta carpeta existe solo para dejar documentada una decisión, a propósito de la
división de bots que pidió Daniel ("Orquestador, ventas, reservas, pagos, postventa,
recontacto"). **No tiene `agente.ts` a propósito y no debería tenerlo nunca**: el registro
(`../_registro.ts`) solo carga carpetas con `agente.ts`, así que esta queda ignorada — es lo
correcto.

## Por qué no es un `DefinicionAgente` como los demás

Todos los demás bots (`ventas`, `reservas`, `pagos`, `postventa`) son **reactivos**: responden a
un mensaje del cliente, en el turno de ese mismo mensaje. "Recontacto" es lo opuesto — es el bot
quien escribe primero, un día antes del check-in, sin que el cliente haya dicho nada. Un
`DefinicionAgente` necesita un mensaje entrante para correr (`runTurn.ts` arranca siempre desde
`handleInbound`); no hay forma de que el orquestador lo enrute, porque no hay ningún mensaje que
enrutar.

## Dónde está construido de verdad

Ya existe, completo, como una tarea programada (no como agente de chat):

- `src/core/queue/recordatorioQueue.ts` — la cola (BullMQ) y cuándo se programa cada aviso
  (`programarRecordatorioVisita`, calculado para que llegue ~9am hora Colombia el día antes del
  check-in).
- `src/core/pipeline/recordatorioVisita.ts` — el mensaje que se manda: la excitación por la
  visita, ayuda con indicaciones, y el saldo pendiente SOLO si el plan se paga un día antes
  (`saldoSePagaUnDiaAntes`) y el cliente todavía debe algo.
- `src/worker/recordatorioWorker.ts` — el worker que lo procesa.
- Se programa automáticamente en `src/core/pipeline/confirmarReserva.ts`, apenas una reserva
  queda confirmada de verdad (pagada), sin que nadie tenga que llamarlo a mano.

## Qué pasa cuando el cliente CONTESTA ese mensaje

Ahí sí vuelve a ser un mensaje entrante normal, como cualquier otro: pasa por
`handleInbound` → el orquestador lo clasifica igual que a cualquier mensaje. Si pregunta por
indicaciones o tiene una duda, cae en `informacion` o `postventa` (según cómo la formule); si
pregunta por el saldo o quiere pagar el restante, cae en `pagos` — `enviar_datos_pago` con
`modalidad="total"` ya usa el saldo real de la base, así que no hizo falta ningún código nuevo
para que ese pago salga por el monto correcto.

No hace falta (ni conviene) un tema `recontacto` propio en el orquestador: la respuesta del
cliente a un recordatorio no es distinta, en el fondo, de escribir por su cuenta sobre lo mismo.
