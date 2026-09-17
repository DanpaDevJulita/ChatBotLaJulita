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
- App name: `bot-lajulita` (o el que quieras)
- Primary region: `mia` (Miami — LATAM, baja latencia)
- Copy Postgres? → `n` (usas Supabase externo)
- Copy Redis? → `n` (usas Upstash externo)

Esto crea `fly.toml` (ya existe en el repo, no sobrescribe).

---

## Paso 3: Configurar variables de entorno

```bash
flyctl secrets set \
  REDIS_URL="tu-url-de-upstash" \
  SUPABASE_URL="tu-url-supabase" \
  SUPABASE_SERVICE_ROLE_KEY="tu-key" \
  OPENROUTER_API_KEY="tu-key" \
  OWNER_WHATSAPP_NUMBERS="tu-numero" \
  PORT=3000
```

**Todas las variables requeridas:**

```bash
flyctl secrets set \
  PORT="3000" \
  NODE_ENV="production" \
  REDIS_URL="rediss://..." \
  SUPABASE_URL="https://..." \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  OPENROUTER_API_KEY="..." \
  OPENROUTER_MODEL="deepseek/deepseek-chat" \
  ORCHESTRATOR_MODEL="deepseek/deepseek-chat" \
  YCLOUD_WHATSAPP_API_URL="https://..." \
  YCLOUD_WHATSAPP_PHONE_ID="..." \
  YCLOUD_WHATSAPP_TOKEN="..." \
  YCLOUD_WHATSAPP_WEBHOOK_TOKEN="..." \
  YCLOUD_WHATSAPP_WEBHOOK_VERIFY_TOKEN="..." \
  BOLD_API_KEY="..." \
  BOLD_BASE_URL="..." \
  BOLD_SECRET_KEY="..." \
  BOLD_WEBHOOK_SECRET="..." \
  LOBBYPMS_API_URL="https://..." \
  LOBBYPMS_API_TOKEN="..." \
  LOBBYPMS_CHANNEL_ID="..." \
  OWNER_WHATSAPP_NUMBERS="..." \
  TEAM_LOGIN_USERS="usuario:clave" \
  TEAM_SECRET_CODE="..." \
  TEAM_SESSION_HOURS="4" \
  REPORTE_FALLAS_NUMBERS="..." \
  HISTORY_TURNS="5" \
  LLM_TEMPERATURE="0.7"
```

**Ver variables configuradas:**
```bash
flyctl secrets list
```

**Ver una variable específica:**
```bash
flyctl secrets show REDIS_URL
```

---

## Paso 4: Desplegar

```bash
flyctl deploy
```

Esto:
1. Detecta que tienes Node.js (por package.json)
2. Instala dependencias (`npm install`)
3. Inicia dos procesos según Procfile:
   - **web:** `npm run web` (Express, puerto 3000)
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
https://bot-lajulita.fly.dev/webhooks/whatsapp
https://bot-lajulita.fly.dev/webhooks/bold
```

(Reemplaza `bot-lajulita` por el nombre de tu app en Fly.io)

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

## Costo estimado

- **Compute (variable):** $48/mes (200 chats/día, 10 paralelo)
- **Base Fly.io:** $3/mes
- **Redis Upstash:** $10-20/mes
- **TOTAL:** ~$61-70/mes

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

