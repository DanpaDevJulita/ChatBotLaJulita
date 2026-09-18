# Bot La Julita — Contexto completo del proyecto

## Resumen ejecutivo

Bot de WhatsApp para La Julita (glampings/hospedería). Orquesta conversaciones con IA, consulta disponibilidad en LobbyPMS, crea reservas, maneja pagos con Bold, y escala automáticamente en Fly.io.

**Stack:** Node.js 24 + TypeScript | Express | BullMQ | Supabase | Redis (Upstash) | OpenRouter LLM | YCloud (WhatsApp) | Bold (pagos) | LobbyPMS (reservas)

---

## Acceso a servicios (credenciales en `.env`)

| Servicio | Propósito | URL de credenciales |
|---|---|---|
| **Supabase** | Base de datos PostgreSQL | https://supabase.com/dashboard — proyecto "lajulita" |
| **OpenRouter** | LLM (Claude, GPT, etc.) | https://openrouter.ai — API key en dashboard |
| **YCloud** | API de WhatsApp | https://console.ycloud.com — token y account ID |
| **Bold** | Pagos con Wompi | https://wompi.com — credenciales en cuenta Bold |
| **Upstash** | Redis remoto | https://console.upstash.com — REDIS_URL en secretos |
| **Fly.io** | Hosting del bot | https://fly.io/apps/botlajulita — app "botlajulita" |
| **LobbyPMS** | Gestión de hospedería | https://api.lobbypms.com — cuenta del cliente |

**IMPORTANTE:** Las credenciales NO están en el repo. Viven en:
- Local: archivo `.env` (excluido de git)
- Producción: `fly secrets list --app botlajulita` (cifradas en Fly)

---

## Arquitectura

```
WhatsApp (YCloud)
    ↓ webhook POST
Express web (puerto 8080)
    ↓ encola mensaje
Redis (Upstash)
    ├─ inbound       (mensajes entrantes)
    ├─ recontacto    (mensajes programados)
    ├─ bloqueo       (pausar conversa)
    └─ recordatorio-visita (recordar próxima visita)
    ↓ BullMQ worker lee
IA (OpenRouter)  +  Supabase (DB)  +  LobbyPMS (disponibilidad)
    ↓ respuesta
YCloud → WhatsApp

Bold (pagos)  ← llamadas directas cuando se crea reserva
```

**Dos procesos en Fly:**
- **web** (512MB): Express, recibe webhooks, encola mensajes
- **worker** (1GB): BullMQ, procesa colas, corre turnos del bot

---

## Cómo correr localmente

```bash
# 1. Instalar dependencias
npm install

# 2. Crear .env desde .env.example (copiar los valores de Supabase, OpenRouter, etc.)
cp .env.example .env
# Editar .env con tus credenciales

# 3. Correr web (en una terminal)
npm run web
# Escucha en http://localhost:8080

# 4. Correr worker (en otra terminal)
npm run worker
# Lee de Redis, procesa turnos

# 5. Probar webhooks
# Usa http://localhost:8080/webhooks/whatsapp (sin producción, dry_run=true en .env)
```

---

## Desplegar a Fly.io

```bash
# 1. Commitear cambios
git add .
git commit -m "tu cambio"

# 2. Desplegar (construye en Fly, no localmente)
npm run deploy
# Equivalente a: flyctl deploy --app botlajulita --remote-only

# 3. Ver logs
npm run logs
# Abre lista, selecciona worker

# 4. Ver estado
npm run estado
```

**Lo más importante:** Fly despliega lo que hay en tu carpeta, no en git. Un archivo sin commitear se sube igual.

---

## Estructura del proyecto

```
src/
├── web/                   # Express, recibe webhooks
│   ├── start.ts          # Servidor HTTP
│   ├── routes/
│   │   ├── webhooks.ts   # POST /webhooks/whatsapp, /webhooks/bold
│   │   └── health.ts     # GET /health
│   └── ...
├── worker/                # BullMQ, procesa colas
│   ├── start.ts          # Inicia worker
│   └── ...
├── core/
│   ├── agentes/          # Los agentes del bot (ventas, soporte, etc.)
│   │   ├── ventas/
│   │   │   ├── agente.ts        # Define el agente
│   │   │   ├── herramientas.ts  # Sus funciones (consultar_planes, etc.)
│   │   │   └── prompt.md        # Su sistema prompt
│   │   └── soporte/
│   │       └── ...
│   ├── db/               # Acceso a Supabase
│   │   └── supabase.ts   # Cliente de Supabase
│   ├── llm/              # OpenRouter
│   │   └── openrouter.ts # Cliente LLM
│   ├── ai/               # Orquestación de turnos
│   │   └── runTurn.ts    # Corre un turno completo del bot
│   └── ...
├── integraciones/
│   ├── ycloud.ts         # WhatsApp: enviar mensajes
│   ├── bold.ts           # Pagos
│   ├── lobbypms.ts       # Disponibilidad, crear reservas
│   └── ...
└── types.ts              # TypeScript types globales

sql/                       # Cambios de esquema (ejecutar en Supabase)
documentation/             # Docs (archivos .md)
```

**Descubrimiento de agentes:** El bot escanea `src/agentes/*/agente.ts` al arrancar y carga cada uno dinámicamente. Sus prompts son archivos `.md` que lee en runtime.

---

## Base de datos (Supabase / PostgreSQL)

**Tablas principales:**
- `planes` — servicios, precios
- `politicas` — términos de servicio
- `domos` — unidades de hospedería
- `adicionales` — extras (spa, desayuno, etc.)
- `recargos` — tasas (IVA, etc.)
- `faq` — preguntas frecuentes
- `configuracion` — settings globales
- `fechas_bloqueadas` — no disponibles
- `promociones` — ofertas
- `tickets` — error reports y learning del bot
- `users` — clientes
- `reservas` — bookings (creadas por bot y panel)
- `pagos` — transacciones Bold
- `mensajes` — auditoría de conversaciones
- `estado_conversacion` — estado de cada chat

**Cambios de esquema:** Daniel prefiere usar el **SQL Editor de Supabase** (no `php artisan migrate`).

---

## Flujos principales

### 1. Mensaje entra por WhatsApp

```
YCloud POST /webhooks/whatsapp
  ↓ valida firma
Express → encola en Redis "inbound"
  ↓
BullMQ worker lee
  ↓
runTurn(numero_whatsapp, mensaje)
  ↓ carga estado anterior del cliente
  ↓ elige agente (ventas, soporte, etc.)
  ↓ agente corre herramientas
  ↓ agente responde
  ↓
ycloud.sendMessage(numero, respuesta)
```

### 2. Cliente pide disponibilidad

Agente ejecuta `consultar_disponibilidad(fecha, personas, tipo_alojamiento)`
  ↓ llama LobbyPMS API
  ↓ devuelve disponibilidad

### 3. Cliente quiere reservar

Agente ejecuta `crear_reserva(...)`
  ↓ si `CREAR_RESERVA_DESDE_BOT=true`
  ↓ llama LobbyPMS API → crea reserva
  ↓ crea registro en Supabase
  ↓ inicia pago con Bold

### 4. Pago llega

Bold POST /webhooks/bold
  ↓ actualiza estado en Supabase
  ↓ marca reserva como pagada

---

## Comandos especiales (solo usuarios autorizados)

| Comando | Qué hace | Quién puede |
|---|---|---|
| `/corrige ...` | Reporta error, crea ticket | OWNER_WHATSAPP_NUMBERS + TEAM_LOGIN_USERS |
| `/aprende ...` | Enseña respuesta al bot | Idem |
| `/reset` | Borra todo, reinicia cliente | Idem |

---

## Operación en Fly.io

```bash
npm run deploy       # Desplegar cambios (2-3 min)
npm run logs         # Ver logs en vivo del worker
npm run estado       # Ver máquinas, CPU, RAM
```

**Costos (2026-09-18):**
- Web (512MB): $3.19/mes
- Worker (1GB): $5.70/mes
- Static IPv4: $3.60/mes
- Redis Upstash: $10-20/mes
- **Total: ~$22-32/mes**

---

## Troubleshooting

**El bot no responde:**
1. Ver logs: `npm run logs`
2. Verificar YCloud apunta a `https://botlajulita.fly.dev/webhooks/whatsapp`
3. Buscar "inbound" en logs — si no aparece, YCloud no está enviando

**LobbyPMS devuelve 403:**
1. Verificar IP: `flyctl ips list --app botlajulita` → debe ser `209.71.78.239`
2. Verificar en LobbyPMS panel: Configuraciones → API → Restricciones

**Redis timeout / Upstash lentitud:**
- Latencia esperada: ~240ms (normal, está en USA, bot en São Paulo)

---

## Próximos pasos

1. Subir panel (LaJulitaWeb) a Railway $5/mes o AWS Free Tier 12 meses
2. Configurar alertas (Slack/email si bot falla)
3. Exportar logs a servicio externo cuando maneje dinero real
4. Agregar tests unitarios de agentes

---

## Info clave

- **Repo:** https://github.com/DanpaDevJulita/bot-lajulita
- **Rama actual:** BotDevelopment
- **Último commit:** a90b3ef
- **Contacto:** Daniel (daniel.pataquiva@lajulitadevelopment.site)
- **Documentación adicional:** carpeta `documentation/`
