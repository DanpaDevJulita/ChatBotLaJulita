# Regla: en las descripciones de los planes, el precio se escribe `$$$$`

> Para quien edita el catálogo desde el panel. Vigente desde el 2026-09-17.

## La regla, en una línea

**En la descripción de un plan, donde iría el precio se escribe el texto literal `$$$$`.** El bot
lo reemplaza solo por el precio que esté cargado en las columnas de ese plan.

```
💰 Entre semana (lunes a viernes): $$$$
💰 Fin de semana (sábado o domingo): $$$$
💰 Sábado o domingo puente festivo $$$$
```

Le llega al cliente así:

```
💰 Entre semana (lunes a viernes): $ 590.000
💰 Fin de semana (sábado o domingo): $ 760.000
💰 Sábado o domingo puente festivo $ 860.000
```

## Por qué

El precio de un plan vive en las columnas `precio_entre_semana`, `precio_fin_de_semana` y
`precio_fin_de_semana_puente`. Si además se escribe a mano dentro de la descripción, queda
escrito dos veces — y el día que alguien cambia la columna, el texto de la descripción queda
viejo. Pasó de verdad: el 2026-09-11 el equipo actualizó el precio del PLAN FAMILIAR 3 PERSONAS
en la columna, la descripción siguió con el valor anterior, y el cliente recibió un mensaje con
**dos precios distintos para el mismo plan**. Con `$$$$` eso no puede pasar: el precio existe en
un solo lugar.

## Cómo elige el bot cuál de los tres precios poner

Por lo que diga **esa misma línea**, así que la palabra importa:

| Si la línea dice… | Usa la columna |
|---|---|
| "puente" o "festivo" | `precio_fin_de_semana_puente` |
| "fin de semana", "sábado", "domingo", "finde" | `precio_fin_de_semana` |
| "entre semana", "lunes a viernes", "lunes a jueves" | `precio_entre_semana` |

Se revisa en ese orden, de lo más específico a lo más general — por eso "Fin de semana festivo"
toma el precio de puente y no el de fin de semana normal.

**Si una línea trae `$$$$` pero no dice ninguna de esas palabras, el bot borra la línea entera**
y deja un aviso en los logs. No adivina: mostrar un precio real pegado a la frase equivocada es
peor que no mostrar nada.

## Montos que NO son el precio del plan

Van escritos normal, con su número. El bot los muestra tal cual, sin tocarlos. Por ejemplo:

```
Cena: dos platos fuertes y dos bebidas (bebidas de hasta $10.000)
```

Eso es un tope de consumo, no una tarifa: no tiene columna y no está duplicado en ninguna otra
tabla, así que se escribe como es.

## Lo que NO va en la descripción

Datos que ya viven en otra tabla, porque se desincronizan igual que se desincronizaba el precio:

- **Recargos de niños** (">3 años $50.000") → están en la tabla `recargos`. El bot los responde
  con su propia herramienta.
- **Precios de otro plan** → cada plan cotiza el suyo. El Domo Deluxe, por ejemplo, es el plan
  id 29: sus precios no van metidos en la descripción del plan de domo clásico.

## El bot no corrige lo que haya en la base

Si un precio está cargado en $5.000, el bot cotiza $5.000. No lo redondea, no lo oculta, no lo
"arregla" — lo que está en la base es lo verdadero, y la base se administra desde el panel. Si un
precio sale raro en una conversación, el lugar donde se corrige es el panel, no el código.

Lo que el bot sí bloquea, y seguirá bloqueando, es que el **modelo** invente una cifra: toda
cifra de dinero del mensaje final tiene que haber salido de una herramienta en ese mismo turno
(ver `montosEn` en `src/core/pipeline/runTurn.ts`). Un número que esté en la descripción sale de
la base, así que pasa sin problema.

## Dónde está esto en el código

- `resolverPreciosEnDescripcion` en `src/agentes/ventas/herramientas/planes.ts` — resuelve el token.
- `scripts/migrar-precios-a-token.ts` — migró los planes que faltaban (28, 30, 31, 32) el
  2026-09-17. Deja respaldo en `_respaldos/` y se puede volver a correr; con `--aplicar` escribe,
  sin el flag solo muestra la vista previa.
- `pruebas/e2e-plantilla-precio.ts` (`npm run prueba:plantilla-precio`) — verifica que el token se
  resuelva bien y que un monto escrito a mano llegue intacto.
- `pruebas/e2e-precio.ts` (`npm run prueba:precio`) — 7 escenarios donde el modelo intenta colar
  un precio que no salió de la base.
