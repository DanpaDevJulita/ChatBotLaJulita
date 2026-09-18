# Deploy en Fly.io — Bot La Julita

## Requisitos previos

1. **Cuenta en Fly.io:** https://fly.io (gratis)
2. **Flyctl CLI instalado:** https://fly.io/docs/hands-on/install-flyctl/
3. **Git con cambios commitados**
4. **Variables de entorno listas** (ver sección abajo)

---

## Paso 1: Instalar y autenticar Flyctl

```bash
# En Windows (PowerShell o WSL)
# Descargar desde https://github.com/superfly/flyctl/releases
# O con Chocolatey: choco install flyctl

flyctl auth login
# Te abre navegador para autenticar con tu cuenta Fly.io
```

---

## Paso 2: Crear la app en Fly.io

```bash
cd tu-proyecto
flyctl launch
```

**Responde las preguntas:**
- App name: `botlajulita` (o el que quieras)
- Primary region: `gru` (São Paulo — la más cercana a Colombia)
- Copy Postgres? → `n` (usas Supabase externo)
- Copy Redis? → `n` (usas Upstash externo)

Esto crea `fly.toml` (ya existe en el repo, no sobrescribe).

---

## Paso 3: Configurar variables de entorno

> **No uses el campo "Variables ambientales" del formulario web de Fly para los tokens.** Ahí
> quedan como variables de entorno normales, legibles en la configuración de la app. Todo lo que
> sea clave o token va por `fly secrets`, que las cifra y solo las expone al proceso corriendo.

Hay un script que lee el `.env` local y lo sube entero, sin que los valores pasen por el
historial de la terminal:

```bash
bash scripts/subir-secretos-fly.sh botlajulita
```

Te muestra la lista de nombres que va a subir y pide confirmación antes de hacer nada.

**Qué sube y qué no.** De las 33 variables del `.env` sube 29:

- **Excluye `PORT`**: ya está declarado en `fly.toml` como 8080. Tenerlo en los dos lados es
  pedir que un día no cuadren.
- **Excluye las que están vacías.** Hoy son tres: `TEAM_SECRET_CODE`, `TEAM_LOGIN_USERS` y
  `REPORTE_FALLAS_NUMBERS`. Subir una variable vacía es peor que no subirla, porque el código que
  hace `?? valor_por_defecto` recibe una cadena vacía —que no es `null`— y se queda con ella.

**Ojo con esas tres vacías:** `TEAM_SECRET_CODE` y `TEAM_LOGIN_USERS` son las que permiten
identificarse desde cualquier número para usar `/corrige`, `/aprende` y `/reset`. Mientras estén
vacías, esos comandos solo funcionan desde los números de `OWNER_WHATSAPP_NUMBERS`.

**Verificar después:**
```bash
fly secrets list --app botlajulita
```
Muestra los nombres y un hash de cada valor, nunca el valor.

**Cambiar una sola variable más adelante:**
```bash
fly secrets set OPENROUTER_API_KEY="..." --app botlajulita
```
Cada `fly secrets set` reinicia las máquinas para que tomen el valor nuevo.

---

## Antes de mover los webhooks: dos banderas que ya están en `true`

El `.env` trae `YCLOUD_DRY_RUN=false` y `CREAR_RESERVA_DESDE_BOT=true`. Es la configuración de
producción y está bien, pero significa que **en cuanto YCloud apunte a Fly, el bot responde de
verdad y crea reservas reales en LobbyPMS**. No hay un modo intermedio: si querés probar el
despliegue sin que conteste a nadie, subí `YCLOUD_DRY_RUN=true` primero y cambialo cuando estés
conforme.

---

## Paso 4: Desplegar

```bash
flyctl deploy
```

Esto:
1. Detecta que tienes Node.js (por package.json)
2. Instala dependencias (`npm install`)
3. Inicia dos procesos según Procfile:
   - **web:** `npm run web` (Express, puerto 8080)
   - **worker:** `npm run worker` (colas BullMQ)
4. Sube a Fly.io
5. Te da una URL pública

**Espera ~2-3 minutos en el primer deploy.**

---

## Paso 5: Verificar que está corriendo

```bash
# Ver logs
flyctl logs

# Ver estado
flyctl status

# Acceder a la app
flyctl open
# O: https://tu-app.fly.dev/health
```

Deberías ver:
```json
{ "ok": true }
```

---

## Paso 6: Configurar webhooks (YCloud, Bold)

En YCloud y Bold, cambia la URL de webhook de tu máquina a:

```
https://botlajulita.fly.dev/webhooks/whatsapp
https://botlajulita.fly.dev/webhooks/bold
```

(Reemplaza `botlajulita` por el nombre de tu app en Fly.io)

---

## Monitoreo y debugging

**Ver logs en tiempo real:**
```bash
flyctl logs -f
```

**Ver configuración actual:**
```bash
flyctl config show
```

**Redeploy sin cambios (reiniciar procesos):**
```bash
flyctl deploy --strategy immediate
```

**Escalar recursos:**
```bash
flyctl scale memory 512  # RAM
flyctl scale vm shared-cpu-1x  # CPU
```

---

## Actualizar después de cambios en código

```bash
git add .
git commit -m "cambios"
git push

# En Fly.io:
flyctl deploy
```

---

## Costo real (verificado en la tabla de precios de Fly, 2026-09-18)

Fly cobra por **máquina asignada corriendo**, a precio fijo — no por consumo variable. Los
precios de `shared-cpu-1x` en la tabla oficial son: 256MB $1.94/mes, 512MB $3.19, 1GB $5.70,
2GB $10.70.

| Concepto | Costo/mes |
|---|---|
| Máquina `web` — shared-cpu-1x, 512MB | $3.19 |
| Máquina `worker` — shared-cpu-1x, 1GB | $5.70 |
| IP de salida estática (IPv4, para LobbyPMS) | $3.60 |
| **Subtotal Fly.io** | **$12.49** |
| Redis Upstash (aparte) | $0-20 según plan |
| **TOTAL** | **~$12-32** |

---

## La IP de salida fija para LobbyPMS

Esto es lo que resuelve el problema de fondo: LobbyPMS exige autorizar la IP desde la que el bot
llama a su API, y hoy esa IP cambia sola cada pocos días.

**Por defecto en Fly la IP de salida NO es estable** — su documentación lo dice explícitamente:
el tráfico IPv4 sale por NAT y la dirección cambia según dónde corra o se reinicie la máquina.
Pero se puede pedir una fija:

```bash
fly ips allocate-egress --app botlajulita -r gru
```

Eso asigna un par IPv4 + IPv6 **fijo para la app**, que sobrevive a los despliegues y a que las
máquinas se recreen. Cuesta **$3.60/mes** (solo se cobra la IPv4).

Detalles que importan:
- Es **por región**. Como todo está en `gru`, con una alcanza.
- Soporta hasta 64 máquinas por IP. Nosotros tenemos 2.
- Solo se libera si corres `fly ips release-egress` a mano.
- **Es UNA sola IP**, no tres — más fácil de autorizar en LobbyPMS que la alternativa de Railway,
  que en su plan Pro ($20/mes) entrega tres IPs balanceadas.

Una vez asignada, se ve con `fly ips list` y se pega en LobbyPMS →
Configuraciones → API → Restricciones → "+ Agregar dirección IP".

---

## Troubleshooting

### El web no inicia
```bash
flyctl logs
# Busca errores en los primeros logs
# Típicamente: variable de entorno faltante
```

### El worker no inicia
- Verifica REDIS_URL (debe ser válida)
- Verifica que BullMQ puede conectar

### Latencia de Upstash alta
- Eso es esperado (~240ms)
- Si quieres mejorar, considera cambiar a Redis en Fly.io (más complejidad)

### Webhooks no llegan
- Verifica que la URL en YCloud/Bold es correcta
- Verifica en logs que Express recibe la solicitud
- Si ves 404, el webhook path está mal

---

## Próximos pasos

1. **Apagar tu máquina / tunnel de Cloudflare** (opcional, cuando estés seguro)
2. **Monitorear en producción** (siempre)
3. **Configurar alertas** (opcional, Fly.io tiene integración con PagerDuty, etc.)

