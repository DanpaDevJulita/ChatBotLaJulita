# Los bots (agentes) — cómo está organizado

Cada bot es **una carpeta** acá adentro, y todo lo suyo vive dentro de esa carpeta: su prompt,
sus herramientas y su archivo de definición. La idea es que varias personas puedan trabajar al
mismo tiempo, cada una en su bot, sin editar los mismos archivos y sin peleas al unir ramas.

## Cómo se arma un bot

```
src/agentes/
  _base.md          prompt común a TODOS (persona, tono, regla de precios, correcciones)
  _tipos.ts         el contrato: DefinicionAgente
  _registro.ts      descubre las carpetas solo — no se edita para sumar un bot
  ventas/
    agente.ts       la definición: nombre, atiende[], prompt y herramientas[]
    prompt.md       el prompt propio de este bot
    herramientas/   las herramientas de este bot
  postventa/
    agente.ts
    prompt.md
    herramientas/
```

**Una carpeta con un `agente.ts` adentro es un bot.** El registro la encuentra sola. Las carpetas
que empiezan con `_` y las que todavía no tienen `agente.ts` se ignoran.

## El campo `atiende`

El orquestador (`orquestador/prompt.md`) clasifica cada mensaje en un tema: `informacion`,
`reservas`, `pagos`, `postventa` o `humano`. Cada bot declara qué temas atiende:

```ts
export const agente: DefinicionAgente = {
  nombre: "ventas",
  atiende: ["informacion", "reservas", "pagos"],   // hoy ventas cubre los tres
  prompt: leerPromptDeAgente("ventas"),
  herramientas: [ ... ],
};
```

Hoy `ventas` atiende tres temas porque todavía no existen los bots de reservas y de pagos por
separado. Sus diseños están en `reservas/` y `pagos/` (con el prompt escrito, sin `agente.ts`).

## Crear un bot nuevo (sin tocar el código de nadie)

1. Creá tu carpeta: `src/agentes/mibot/`.
2. Poné tu `prompt.md` ahí.
3. Poné tus herramientas en `mibot/herramientas/`.
4. Creá `mibot/agente.ts` exportando `agente` (copiá el de `postventa/agente.ts` como molde).
5. Si tu bot se queda con un tema que hoy atiende otro, **sacá ese tema del `atiende` del otro
   agente** — es el único cambio fuera de tu carpeta, y es una línea.
6. Verificá: `npx tsx scripts/probar-agentes.ts`

No hay que registrar nada en ningún índice ni tocar el pipeline.

## Herramientas que usan dos bots

Viven en la carpeta de su bot dueño y el otro las importa — **no se duplican**. Por ejemplo,
postventa importa `consultar_planes` de `ventas/herramientas/planes.js` para poder ofrecer una
fecha alternativa cuando el cliente no tiene reserva.

Si duplicáramos el archivo, un arreglo de precios habría que hacerlo dos veces, y así es como se
terminan desincronizando los precios entre agentes.

**Regla de convivencia:** si vas a cambiar una herramienta que otro bot importa, avisale a quien
lleva ese bot. Los `import` de cada `agente.ts` dicen exactamente quién depende de qué.

## Qué NO va en la carpeta de un bot

La infraestructura compartida vive en `src/core/`: base de datos (`db/`), colas (`queue/`),
LLM (`llm/`), integraciones como LobbyPMS (`integrations/`), utilidades (`lib/`) y el pipeline
del turno (`pipeline/`). Eso lo usan todos los bots; se toca de a poco y avisando.

`src/channels/` (WhatsApp, consola) tampoco: el bot nunca sabe por qué canal le hablan.
