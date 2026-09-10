# Prueba de funcionamiento — 9 de septiembre de 2026

Reporte fuente: `diagnostico-2026-09-09-13-57.txt` (12 secciones, corrido en tu máquina con
red real: Supabase, OpenRouter, YCloud y Redis de verdad).

## Resultado en una línea

**Todo lo que construimos funciona.** Los 2 "problemas" que salieron en el resumen eran
defectos de **mis scripts de verificación**, no de tu bot ni de tu base de datos. Ya quedaron
corregidos, y en el camino encontré **un error real que el reporte no estaba mirando**: el
panel de administración no podía guardar precios.

---

## 1. Qué se verificó y cómo salió

| # | Sección | Resultado |
|---|---------|-----------|
| 1 | Configuración (.env) | OK — todas las llaves presentes; el único aviso era `ORCHESTRATOR_MODEL` sin definir (ya definido) |
| 2 | Tablas de Supabase | OK — las 17 tablas responden |
| 3 | Datos reales del catálogo | OK — 20 planes activos, 8 domos, 3 clases, 15 adicionales |
| 4 | Herramientas del bot | OK — 20 variantes de `consultar_planes`, ninguna pasa el límite de WhatsApp (máx. 1.413 de 4.096 caracteres) |
| 5 | Modelo (OpenRouter) | OK — **10/10** turno 1 (pregunta sin soltar precios) y **10/10** turno 2 (llama la herramienta con los datos) |
| 6 | Orquestador | OK — **10/10** enrutamientos correctos, incluida la pegajosidad ("somos 4" sigue en reservas) |
| 7 | Pipeline completo | OK — conversación de 10 turnos completa, `last_agent` persistido, 18 mensajes guardados |
| 8 | Canal WhatsApp / YCloud | OK — firma válida aceptada, firma falsa rechazada, webhook viejo rechazado, credenciales HTTP 200, número de la cuenta coincide |
| 9 | Cola Redis / BullMQ | OK — PONG, 0 trabajos fallidos, 2 completados |
| 10 | Recontacto automático | OK — cadena 20 min → 3 h → 6 h, ventana nocturna 21:00–07:00 correcta en las 6 pruebas de hora |
| 11 | Registro de reserva | OK — los 6 casos de datos incompletos piden exactamente lo que falta, sin escribir nada mal |
| 12 | Aprendizaje asistido | OK — las tablas existen, un número desconocido NO puede usar `/corrige` |

### Lo importante del punto 7 (la conversación de verdad)

El bot, en 10 turnos seguidos: saludó y preguntó segmento + fecha → mostró el menú de tres
experiencias con precios **de la base** → paginó "muéstrame otros" y "¿y otros más?" sin
repetir → detalló el Plan Paraíso completo → contestó el check-in → al pedir reservar dio el
precio del día exacto, la política de 50 % y los medios de pago → y al pedir "una persona real"
escaló a humano. Ni un precio inventado en toda la conversación.

---

## 2. Los 2 "problemas" del resumen: falsas alarmas (ya corregidas)

**1. `column planes.capacidad does not exist`**
La columna `capacidad` no existe en tu tabla `planes` (se quitó en el rediseño) y **está bien
que no exista**: la capacidad sale del nombre del plan ("...PARA DOS PERSONAS") y de
`domos.capacidad_max`. El bot ya la deduce así. El error lo producía mi script, que la pedía
explícitamente en un `select` y por eso fallaba la lectura completa.
→ Corregido en `scripts/diagnostico.ts` y quitada la referencia muerta en el código
(`capacidadDePlan`, interfaz `Plan`).

**2. `la tabla estado está VACÍA y reservas.estado_id es NOT NULL`**
Solo importa si el bot **crea** la reserva. Por tu decisión, `CREAR_RESERVA_DESDE_BOT=false`:
el bot solo guarda cliente + acompañantes y el equipo crea la reserva. Con eso, `estado`
vacía no rompe nada.
→ El chequeo ahora depende de `CREAR_RESERVA_DESDE_BOT`: si está en `false`, lo informa como
dato, no como problema.

---

## 3. Errores REALES que sí encontré (y arreglé)

### 3.1 El panel de administración no podía guardar precios ← el más grave
El panel le mandaba a `planes` las columnas `precio`, `capacidad` y `orden`. **Ninguna de las
tres existe** en la tabla (el rediseño las cambió por `precio_entre_semana`,
`precio_fin_de_semana`, `precio_fin_de_semana_puente`). Cada clic en "Guardar" moría con error
42703. En `adicionales` pasaba lo mismo con `activo` (la columna se llama `estado`) y `orden`,
y no mandaba el `tipo_adicional_id` que es obligatorio.

Esto choca de frente con lo que pediste: que **los vendedores actualicen los precios en la base
de datos**. El panel es la herramienta para eso y estaba roto.

Arreglado:
- La tabla de planes ahora tiene las tres columnas de precio reales, editables.
- La de adicionales usa `estado` y un desplegable con los tipos (`tipo_adicional`), con su
  endpoint nuevo `GET /admin/api/tipo-adicional`.
- El servidor **filtra** las columnas antes de escribir, así una pantalla vieja en caché no
  vuelve a romper el guardado.
- `scripts/estructura-db.ts` tiene una sección nueva —
  "¿PUEDE EL EQUIPO EDITAR PRECIOS DESDE EL PANEL?" — que compara columna por columna lo que
  el panel escribe contra lo que existe en la base. Si vuelve a desalinearse, sale en el reporte.

### 3.2 A una pareja se le ofrecía el "PLAN AMIGAS 3 PERSONAS"
Con `personas=2` y sin segmento, el filtro solo miraba que el plan "quepa": un plan de 3
personas le cabe a una pareja, así que aparecía en la escalera. Ahora, si el cliente dice
cuántos son pero no el segmento, se deduce: 1 → solo, 2 → pareja, 4+ → familia. El 3 se deja
sin deducir a propósito (puede ser amigas o familia de 3, y ahí sí conviene mostrar las dos).

### 3.3 El menú de pasadías hablaba de "noche"
Pidiendo pasadía salía "🏕️🌙 **Planes por noche** — Incluye noche, jacuzzi y desayuno.
Desde $ 3.690.000". Un pasadía no incluye noche: sus versiones son básico / intermedio /
premium. Ahora los pasadías se muestran directo, con encabezado propio
("☀️ Pasadías ... van de día, sin dormir") y cierre que pregunta el **día**, no la fecha de
estadía. También se corrigió que el segmento deducido (pareja, por ser 2 personas) borraba los
pasadías cuando se pedían por `tipo`.

---

## 4. Lo que queda pendiente y NO es del bot

**Datos del negocio en la base** (por tu decisión, se dejan así hasta producción — el bot
cotiza lo que haya en la base, y con el panel arreglado ya se pueden corregir en 2 minutos):

- `PLAN UNA PERSONA UNA NOCHE DOMO DELUXE`: entre semana **$ 5.690.000** (probablemente
  $ 569.000 o $ 590.000). Es el que más se nota porque distorsiona el "desde".
- `PASADIA BASICO ENTRE SEMANA`: **$ 3.690.000** (probablemente $ 369.000).
- `PLAN PARAISO`: entre semana $ 1.490.000 vs. fin de semana $ 3.000.000 — el salto es raro.
- `PLAN FAMILIAR 3 y 4 PERSONAS` y `PLAN AMIGAS 3 PERSONAS` tienen la misma descripción
  ("jacuzzi, fogata, quebrada natural"), así que el bot no puede diferenciarlas al venderlas.
- `PLAN CONFORT`, `PLAN LUJO`, `PLAN PARAISO` y los pasadías no tienen tarifa de puente
  festivo cargada ($ 0 = "no se vende ese día"; si sí se vende, hay que cargarla).
- Tablas `faq` y `configuracion` vacías: por eso `consultar_horarios` y `preguntas_frecuentes`
  siguen desactivadas. Los horarios el bot ya los sabe por el prompt.

**Configuración opcional:** `TEAM_SECRET_CODE` y `TEAM_LOGIN_USERS` siguen vacíos (usuario y
clave del equipo — quedó para más adelante). Mientras tanto, las correcciones funcionan por
atajo desde tu número: **+573212191805**.

**Seguridad, sin fecha aún:** las llaves de OpenRouter, YCloud, Supabase y Redis quedaron a la
vista en esta sesión de trabajo. Hay que rotarlas antes de producción.

---

## 5. Para volver a probar

```powershell
# 1. reiniciar los dos procesos (los cambios de código NO se aplican sin esto)
npm run web
npm run worker

# 2. el diagnóstico completo — ahora debería salir con 0 problemas y 0 avisos
npx tsx scripts/diagnostico.ts

# 3. la estructura de la base + el chequeo nuevo del panel
npx tsx scripts/estructura-db.ts
```

Después: entrar al panel (`/admin`), abrir la pestaña **Planes** y corregir un precio para
comprobar que ya guarda; y por WhatsApp probar un pasadía ("somos 2, queremos ir solo de día")
para ver el encabezado nuevo.
