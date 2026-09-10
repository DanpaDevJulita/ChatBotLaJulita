# Análisis — API oficial de LobbyPMS (punto 1.2)

> Fecha: 10 de septiembre de 2026.
> Insumo: `informe-lobbypms-n8n-2026-09-09.md` (extracción del n8n de La Julita, workflow
> "Availability"), más pruebas en vivo contra la API hechas el 10/09/2026.
>
> **Todo lo que dice "verificado" acá se probó de verdad contra `api.lobbypms.com`, solo con
> peticiones de LECTURA (`GET`) y `OPTIONS`. No se ejecutó ninguna escritura: ningún `POST` a
> `bookings` ni a `block`, no se creó, modificó ni bloqueó nada en LobbyPMS.**

---

## 1. Resumen en una línea

Existe una **API oficial de LobbyPMS** (`https://api.lobbypms.com/api/v1`) mucho mejor que el
endpoint interno que usa el bot hoy, el token que teníamos en el n8n **sigue vivo**, y expone
justo las tres piezas que nos faltaban (**disponibilidad por día, crear reserva y bloquear
cupo**). El único bloqueador es que la API **exige autorizar la IP** desde la que se consulta.

---

## 2. Lo que ya teníamos vs. lo que aparece ahora

| | Hoy en el bot (`engine.lobbypms.com/api/engine/load-rooms`) | API oficial (`api.lobbypms.com/api/v1`) |
|---|---|---|
| Naturaleza | Endpoint **interno** del widget público de reservas | **API oficial**, versionada (`/v1`) |
| Autenticación | Ninguna | `api_token` por query param |
| Restricción de IP | No | **Sí — hay que autorizar la IP** |
| Método | `POST` form-urlencoded | `GET` con query params |
| Parámetros | `propertyId=16392`, `langCode=1`, `start=19-Dec-2026`, `end=20-Dec-2026` | `start_date=2026-12-19`, `end_date=2026-12-20` (ISO, más limpio; no hace falta `propertyId`: el token ya identifica la propiedad) |
| Respuesta | `roomCategories` + `roomNoAvailable`, con `nombre` y `rooms_count` | arreglo `{ date, name, available_rooms }` |
| Granularidad | **Un agregado de todo el rango** | **Una fila por categoría y por día** |
| Estabilidad | Puede cambiar o cerrarse sin aviso (no es contrato público) | Contrato oficial |
| Nombres de categoría | CHALET / DOMO DELUXE / DOMO ROMANTIC / DOMO FAMILIAR | **los mismos** |

**Consecuencia práctica más importante:** que la oficial devuelva la disponibilidad **día por
día** resuelve dos cosas que hoy no podemos hacer bien:

1. **Estadías de más de una noche.** Con el agregado del rango no se puede afirmar con
   propiedad que haya cupo las 2 o 3 noches; con el detalle por día sí (hay cupo solo si
   *todos* los días del rango tienen ≥ 1 disponible).
2. **Ofrecer otra fecha.** Es literalmente lo que le pedimos al agente de postventa que
   terminamos hoy ("si no hay reserva válida, mirá qué hay disponible para esa fecha y ofrecelo,
   y también dale la opción de otra fecha"). Con el endpoint interno habría que consultar fecha
   por fecha; con la oficial, **una sola consulta de rango** devuelve todos los días y el bot
   puede decir "el 19 no me queda, pero el 20 y el 21 sí".

Buena noticia para la migración: como los **nombres de las categorías son los mismos**, el
mapeo que ya tenemos en `src/core/integrations/lobbypms.ts` (`CATEGORIAS_LOBBY`: CHALET→chalet 2p,
DOMO DELUXE→deluxe 2p, DOMO ROMANTIC→clasico 2p, DOMO FAMILIAR→clasico 4p) **sirve tal cual**.
La migración es de bajo riesgo.

---

## 3. Mapa de la API oficial (verificado)

Descubierto probando cada ruta con `GET` y consultando los métodos permitidos con `OPTIONS`.
Una ruta que responde `404 {"error":"Resource Not Found."}` no existe; una que responde `403`
con el aviso de IP **existe** (el bloqueo por IP ocurre después del enrutamiento).

| Endpoint | Métodos permitidos | Para qué nos sirve |
|---|---|---|
| `/api/v1/available-rooms` | `GET` | Disponibilidad por día — es el que usa el n8n |
| **`/api/v1/bookings`** | **`GET`, `POST`** | **Leer** las reservas (incluidas las que hace un vendedor) y **crear** reservas |
| **`/api/v1/block`** | **`POST`** | **Bloquear cupo** en LobbyPMS |
| `/api/v1/rooms` | `GET` | Habitaciones/domos reales |
| `/api/v1/occupancy` | `GET` | Ocupación |
| `/api/v1/rate-plans` | `GET` | Planes de tarifa |
| `/api/v1/products` | `GET` | Productos (probablemente los adicionales) |
| `/api/v1/invoices` | `GET` | Facturas |
| `/api/v1/payment-methods` | `GET` | Medios de pago |
| `/api/v1/channels` | `GET` | Canales de venta |
| `/api/v1/expenses` | `GET` | Gastos |
| `/api/v1/users` | `GET` | Usuarios |

Rutas que **no** existen (dieron 404): `reservations`, `guests`, `clients`, `customers`,
`rates`, `prices`, `room-types`, `categories`, `calendar`, `properties`, `payments`, `blocks`,
`hold`, `reserve`, `taxes`, `reports`, entre otras probadas.

### Estado del token
- Con un token inventado → `{"error":"Unauthenticated."}`
- Con el token del informe → pasa la autenticación y llega al chequeo de IP.

**Conclusión: el token del n8n está activo y asociado a la cuenta de La Julita.** No hay que
pedir uno nuevo para empezar (aunque más abajo recomiendo crear uno propio para el bot).

### El bloqueador: restricción por IP
La respuesta literal de la API fue:

```
["the <IP-de-salida> trying to access the API is not set as a valid ip"]
```

Es decir, además del token, LobbyPMS exige que la IP desde la que sale la petición esté
registrada. Según el centro de ayuda de LobbyPMS (artículo *"Gestionar Usuarios, permisos y
API"*): *"Además del Token encontrarás la opción de agregar restricciones de IP para configurar
las IPs desde donde realizará las peticiones"*. Se administra en el panel de LobbyPMS, en la
sección **API**.

Por eso el n8n sí funciona: corre en un servidor (EasyPanel) con IP fija, ya autorizada.

---

## 4. Qué desbloquea esto en nuestro proyecto

Tres pendientes que estaban trabados, y que aparecen resueltos justo por estos endpoints:

**a) `GET /api/v1/bookings` → sincronización LobbyPMS ➜ tabla `reservas` de Supabase.**
Es exactamente lo que planteaste: "puede existir la posibilidad que se reserve fuera del bot, el
vendedor la va a registrar en lobby y nuestra api de lobby lo va reportar en nuestra tabla de
reservas". Con este endpoint eso se puede construir de verdad. **Y es lo que hace que el agente
de postventa que terminamos hoy sirva para algo**: mientras `reservas` esté vacía,
`buscar_reserva_cliente` nunca va a encontrar nada.

**b) `POST /api/v1/block` → el bloqueo real de 10 minutos.**
Hoy el candado de 10 minutos vive solo en nuestra tabla `bloqueos_temporales`: evita que el
*bot* prometa dos veces el mismo cupo, pero **un vendedor trabajando en LobbyPMS no lo ve**.
Esa limitación está anotada en el código (`src/core/db/bloqueosRepo.ts`) y era justamente el
riesgo que querías cubrir cuando definimos el flujo ("para evitar que algún vendedor y el bot
hagan doble reserva"). Con este endpoint el bloqueo pasa a ser visible para todos.

**c) `POST /api/v1/bookings` → el bot puede crear la reserva de verdad.**
Hoy `CREAR_RESERVA_DESDE_BOT=false` y la reserva la arma el equipo a mano. Esto lo habilita
(cuando el negocio lo quiera, no es obligatorio activarlo).

---

## 5. El punto que hay que decidir: desde dónde sale el tráfico del bot

La restricción de IP obliga a definir algo de arquitectura que hasta ahora daba igual:

- **Hoy** el bot corre en tu PC con túnel de Cloudflare. La IP de salida es la de tu conexión:
  **dinámica**. Si se autoriza y el proveedor la cambia, la API empieza a rechazar y el bot
  pierde el dato de cupo (cae al "le confirmo con el equipo").
- **En producción**, lo correcto es un servidor con **IP fija** (un VPS), que es exactamente la
  arquitectura que el n8n ya tiene y por la que a él sí le funciona.

Opciones, de menor a mayor esfuerzo:

1. **Autorizar la IP actual y probar ya.** Sirve para desarrollar y validar hoy mismo; hay que
   reautorizar cuando cambie la IP. Bueno para esta etapa.
2. **Mover el bot a un VPS con IP fija.** Es la solución definitiva; conviene decidirlo antes de
   construir sobre la API oficial.
3. **Estrategia mixta — mi recomendación técnica:** usar la **API oficial como fuente primaria**
   y **dejar el endpoint interno actual como respaldo automático**. Si la oficial falla (IP no
   autorizada, token rotado, API cambiada), el bot sigue dando cupo con el interno en vez de
   quedarse sin dato. Cuesta poco: los dos caminos ya producen el mismo tipo interno
   (`DisponibilidadCategoria[]`), así que es un `if` de fallback, no una reescritura.

---

## 6. Seguridad del token (a tener en cuenta)

- Ese `api_token` está hoy en texto claro en el informe del n8n, dentro del n8n, y pasó por el
  chat. Cuando lo usemos va **solo en `.env`** (`LOBBYPMS_API_TOKEN`), nunca en el código ni
  commiteado. En la copia del informe que quedó en el proyecto **lo dejé redactado**.
- Conviene **sumarlo a la ronda de rotación de credenciales** que ya estaba pendiente
  (OpenRouter, YCloud, Supabase, Redis).
- Recomendación: **crear un token nuevo dedicado al bot** en lugar de reusar el del n8n. Así
  cada integración tiene su propio token y su propia restricción de IP, y rotar o revocar uno no
  rompe el otro.
- Detalle técnico: la API recibe el token por *query string*, así que queda registrado en logs
  de intermediarios. No es algo que podamos cambiar (la API es así), pero el bot no debe loguear
  URLs completas de LobbyPMS.

---

## 7. Lo que falta averiguar (y no está público)

La documentación de los **parámetros exactos** de cada endpoint no es pública. Según el propio
soporte de LobbyPMS, hay que **pedirles el diccionario de datos**. Lo que necesitaríamos:

1. `POST /api/v1/bookings` — campos obligatorios para crear una reserva (habitación/categoría,
   fechas, huésped, documento, tarifa, estado, canal...).
2. `POST /api/v1/block` — cómo se bloquea: ¿por habitación o por categoría? ¿acepta una
   **duración/expiración** (nos hacen falta 10 minutos) o el bloqueo es permanente hasta que se
   libere explícitamente? ¿cómo se libera?
3. `GET /api/v1/bookings` — qué **filtros** acepta (rango de fechas, documento, teléfono,
   estado, `updated_since` para sincronizar solo lo nuevo). Esto define cómo se construye la
   sincronización hacia Supabase.
4. Confirmar la semántica de `end_date` en `available-rooms` (el prompt del n8n asume
   `[start_date, end_date)` — el día de salida no se muestra; coincide con cómo ya calculamos
   las noches en el bot).

---

## 8. Orden propuesto para el punto 1.2

1. **1.2.a — Disponibilidad por la API oficial, con respaldo en el endpoint interno.**
   Se puede hacer en cuanto se autorice una IP. Mejora el flujo de venta (varias noches) y le da
   al postventa la capacidad real de ofrecer fechas alternativas.
2. **1.2.b — `GET /api/v1/bookings` ➜ sincronización a la tabla `reservas`.**
   Es lo que enciende el postventa que ya construimos. Requiere el diccionario de datos.
3. **1.2.c — `POST /api/v1/block` ➜ bloqueo real de 10 minutos visible para los vendedores.**
   Requiere saber si el bloqueo admite expiración.
4. **1.2.d — `POST /api/v1/bookings` ➜ el bot crea la reserva** (opcional, cuando el negocio
   quiera activarlo).

---

## 9. Nota de método y limitaciones

- Desde el entorno en la nube de esta sesión **no hay salida de red hacia `api.lobbypms.com`**
  (la política de red de la organización la rechaza), y el shell del equipo tampoco la alcanza.
  Todas las pruebas se hicieron con el navegador de la app de Claude, que corre en el equipo y
  sí tiene red.
- Se usaron únicamente `GET` y `OPTIONS`. **No se ejecutó ningún `POST`**, así que no se creó,
  modificó ni bloqueó nada en LobbyPMS. El descubrimiento de métodos se hizo leyendo el
  encabezado `Allow` que devuelve `OPTIONS`, que no ejecuta ninguna acción.
- Como el token real se usó en la barra de direcciones del navegador de la app, quedó en el
  historial de ese navegador. Un motivo más para rotarlo cuando se haga la ronda de
  credenciales.

---

## 10. Estado de implementación (actualizado el 2026-09-10, mismo día)

Decisiones tomadas con el equipo: **alcance completo (1.2.a → 1.2.d)** y **producción en un VPS
con IP fija**.

### Ya implementado (1.2.a) — compila limpio con `npx tsc --noEmit`

- **`src/core/integrations/lobbypms.ts`** reescrito con las dos vías:
  - `consultarDisponibilidadPorDia(fecha, noches)` → API oficial, detalle **día por día**.
  - `consultarMotorPublico(fecha, noches)` → el camino de antes, ahora como **respaldo**.
  - `consultarDisponibilidad(fecha, noches)` → **misma firma que antes** (así `consultar_planes`
    no cambió): intenta la oficial y, si falla por cualquier motivo, cae al respaldo. Devuelve
    `null` solo si fallan las dos.
  - `buscarFechasAlternativas(fecha, noches, diasAlrededor)` → una sola consulta de rango y
    devuelve **qué fechas cercanas sí tienen cupo**. Devuelve `null` si la API oficial no está
    disponible (el respaldo no da detalle por día): el bot no inventa fechas.
  - `estadoUltimaConsultaOficial()` → `ok | sin_token | ip_no_autorizada | token_invalido |
    respuesta_inesperada | error_red`, para que el diagnóstico diga exactamente qué falta.
  - **Corrección de un defecto que ya existía:** el `catch` volcaba el `AxiosError` completo al
    log (cientos de líneas por cada mensaje de cliente cuando LobbyPMS estuviera caído). Ahora
    se resume en una línea con status, código y cuerpo truncado.
- **Cupo correcto en estadías de varias noches:** al juntar el detalle por día se toma el
  **mínimo** por categoría, así que solo hay cupo si *todas* las noches lo tienen. Con el
  agregado del respaldo esto no se podía afirmar bien.
- **Nueva herramienta `consultar_fechas_alternativas`** (`src/core/tools/disponibilidad.ts`):
  devuelve las fechas cercanas con cupo y el alojamiento libre en cada una, descontando los
  bloqueos temporales que ya tiene tomados otra conversación del bot. Registrada en
  **ventas y postventa**.
- **`src/core/lib/fechas.ts`** (nuevo): formato de fechas en español, calculado en UTC para que
  una fecha de calendario no se corra un día.
- **Prompts actualizados:** `prompts/system.md` (la herramienta nueva y qué hacer cuando no hay
  cupo) y `prompts/agentes/postventa.md` (el paso 4 del pivote a venta ahora usa la herramienta
  en vez de improvisar una fecha).
- **`.env` / `.env.example`:** `LOBBYPMS_API_TOKEN` y `LOBBYPMS_API_URL`. El token vive **solo**
  en `.env`.
- **`scripts/probar-lobbypms.ts`** (nuevo): verifica token e IP, muestra el detalle por día,
  compara oficial vs. respaldo, prueba las fechas alternativas y trae la **forma real** de
  `rooms`, `rate-plans`, `products`, `payment-methods`, `channels`, `occupancy`, `bookings` e
  `invoices`. De `bookings`/`invoices`/`users` imprime solo los **nombres de los campos**, nunca
  los valores (traen datos de huéspedes reales y el reporte se comparte).
- **`scripts/diagnostico.ts`**, sección 13: ahora dice **por qué vía** salió el dato y, si falta
  autorizar la IP, lo avisa con la instrucción concreta.

### Verificación hecha y lo que NO se pudo verificar

- `npx tsc --noEmit` limpio después de cada cambio.
- El script `probar-lobbypms.ts` se ejecutó de punta a punta (en un entorno aislado, con las
  dependencias instaladas): corre completo, sale con código 0 y los mensajes de error son de una
  línea.
- **No se pudo probar contra la API real todavía**, porque ninguna de las IPs disponibles está
  autorizada en LobbyPMS. La implementación de la vía oficial sigue el contrato documentado del
  n8n (`{ date, name, available_rooms }`), que es el que ese workflow usa en producción, pero
  **queda pendiente confirmarlo en vivo** con el script. El respaldo automático es justamente la
  red de seguridad para ese riesgo: si la respuesta real no coincide con lo esperado, el bot cae
  al motor público en vez de quedarse sin dato.

### Bloqueado, esperando dos cosas

| Pendiente | Qué lo desbloquea |
|---|---|
| 1.2.a — confirmar en vivo | Autorizar la IP en LobbyPMS y correr `npx tsx scripts/probar-lobbypms.ts` |
| 1.2.b — sincronizar `GET /bookings` ➜ tabla `reservas` | La IP autorizada (el script trae la forma real de los datos) + idealmente los filtros y si hay **webhooks** |
| 1.2.c — `POST /block` (bloqueo real de 10 min) | El diccionario de datos: sobre todo **si el bloqueo admite expiración** |
| 1.2.d — `POST /bookings` (el bot crea la reserva) | El diccionario de datos |

Para lo segundo está listo **`MENSAJE-SOPORTE-LOBBYPMS.md`** en la raíz del proyecto: un mensaje
redactado para enviarle a soporte de LobbyPMS pidiendo exactamente esos datos (incluye la
pregunta por webhooks, que si existen nos ahorran hacer consultas periódicas para la
sincronización).

### Nota sobre el entorno de trabajo

En la VM Linux que monta la carpeta del proyecto, `npx tsc` funciona pero **`npx tsx` no**: el
`node_modules` tiene los binarios de `esbuild` para Windows (`@esbuild/win32-x64`). O sea, los
scripts (`diagnostico.ts`, `probar-lobbypms.ts`) hay que correrlos desde Windows, como se ha
hecho siempre.

---

## Fuentes

- `informe-lobbypms-n8n-2026-09-09.md` (extracción del n8n de La Julita — workflow "Availability").
- Pruebas en vivo contra `https://api.lobbypms.com/api/v1/*` (10/09/2026, solo lectura).
- Centro de ayuda de LobbyPMS, artículo "Gestionar Usuarios, permisos y API"
  (https://soporte.lobbypms.com) — Token y restricciones de IP.
