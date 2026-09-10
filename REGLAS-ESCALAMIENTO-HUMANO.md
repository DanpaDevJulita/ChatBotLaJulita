# Reglas de escalamiento a humano — punto 3 (+ notificaciones, punto 4)

> [2026-09-10] Antes de esto, el orquestador YA sabía decidir "humano" (existía en el prompt y en
> `runTurn.ts`), pero no pasaba nada más allá de un log y el mensaje al cliente — nadie del
> equipo se enteraba salvo que estuviera mirando la consola del servidor o el panel de admin en
> ese momento. Esto completa lo que faltaba: cuándo escalar (se refinó), avisar de verdad al
> equipo, no repetirle lo mismo al cliente en cada mensaje mientras espera, y cómo el equipo
> cierra el caso.

## 1. Cuándo se escala (`src/agentes/orquestador/prompt.md`)

El orquestador manda a `humano` cuando:

- El cliente está molesto/frustrado de forma explícita, o pide hablar con una persona.
- Reclama por un error del bot.
- El mensaje no encaja en ningún otro tema después de intentarlo con `informacion` una vez.
- Dice que ya pagó y el sistema no lo tiene registrado (disputa de pago).
- **Nuevo:** pide cambiar fechas o cancelar una reserva ya confirmada. Antes esto iba a
  `postventa`, que solo podía decir "ya le aviso al equipo" sin que ese aviso pasara de ahí —
  una promesa vacía. Ahora va directo a `humano`, que sí dispara el aviso real (ver abajo).
  `postventa` sigue quedándose con: dudas durante la estadía y upsell de adicionales — eso el
  bot todavía lo puede resolver solo.

## 2. Qué pasa quien se escala (`src/core/pipeline/runTurn.ts`)

**Primera vez en la conversación** (`estado.escalado_en` todavía vacío):
1. Al cliente se le manda el mensaje completo ("ya te comunico con el equipo...").
2. Se llama a `notificarEscalamiento()` (`src/core/pipeline/notificarEquipo.ts`): manda un
   WhatsApp de verdad a cada número de `OWNER_WHATSAPP_NUMBERS`, con el número del cliente, el
   motivo y su último mensaje — y el recordatorio de mandar `/resuelto <número>` cuando ya lo
   atendieron.
3. Se marca `escalado_en = ahora` en `estado_conversacion` (tabla ya existente, dos columnas
   nuevas — ver `sql/escalamiento-humano.sql`).
4. Se cancela el recontacto automático (como ya hacía antes): el bot no vuelve a insistirle solo.

**Si el cliente sigue escribiendo mientras espera** (`escalado_en` ya tenía fecha):
- NO se repite el mensaje completo en cada mensaje suyo (se sentiría como un bot roto en loop).
- NO se vuelve a notificar al equipo por cada mensaje (evita spam) — su mensaje ya queda
  guardado en `mensajes` y visible en el panel de administración de todas formas.
- Si pasaron más de 15 minutos desde el último aviso, se le manda un recordatorio corto ("tu
  mensaje ya quedó con el equipo..."). Si no, el bot queda en silencio ese turno.

## 3. Cómo el equipo cierra el caso

Comando nuevo por WhatsApp (mismo mecanismo que `/corrige`, `/confirmar`, etc. — necesita estar
en `OWNER_WHATSAPP_NUMBERS` o haberse identificado con `/soy`):

```
/resuelto 3001234567
```//(alias: /reanudar)

Limpia `escalado_en` y resetea `last_agent` para ese cliente: su próximo mensaje lo reclasifica
el orquestador desde cero, en vez de quedar pegado a "humano" para siempre.

## 4. Qué falta / decisiones que quedaron afuera a propósito

- **Un solo aviso por escalamiento.** Si el equipo no responde en horas, hoy no hay un segundo
  recordatorio automático hacia el equipo (solo hacia el cliente, cada 15 min si sigue
  escribiendo). Se puede sumar un job que revise `estado_conversacion` cada tanto y re-avise si
  `escalado_en` es muy viejo y sigue sin `/resuelto` — no se hizo ahora para no adivinar cada
  cuánto lo quiere el equipo.
- **Notificación solo por WhatsApp.** No se agregó email ni otro canal — es el mismo lugar donde
  el equipo ya recibe `/corrige` y compañía, así que no hace falta uno nuevo por ahora.
- **`/resuelto` busca en el mismo canal del comando.** Si algún día hay escalamientos por otro
  canal (Instagram, etc.), el comando seguiría funcionando igual — busca dentro del canal desde
  el que se manda el comando, que hoy siempre es WhatsApp.

## Archivos tocados

- `src/agentes/orquestador/prompt.md` — criterio de cuándo escalar (cambios/cancelación ahora
  van directo a `humano`).
- `src/agentes/postventa/prompt.md` — ya no promete un aviso que no pasaba a ningún lado.
- `src/core/pipeline/runTurn.ts` — la lógica de primera-vez vs. ya-escalada.
- `src/core/pipeline/notificarEquipo.ts` (nuevo) — el aviso real por WhatsApp al equipo.
- `src/core/pipeline/comandos.ts` — comando `/resuelto` (alias `/reanudar`).
- `src/core/db/estadoRepo.ts` — columnas `escalado_en` / `ultimo_aviso_humano_en` y las
  funciones para leerlas/escribirlas.
- `sql/escalamiento-humano.sql` (nuevo) — la migración; correrla en el SQL editor de Supabase.
