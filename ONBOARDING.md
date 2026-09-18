# Onboarding — Bot La Julita

Bienvenido al proyecto. Este documento te guía en 5 minutos.

---

## Lo primero: entender qué es

Un bot de WhatsApp que:
- Contesta preguntas sobre hospedería (planes, precios, disponibilidad)
- Consulta un sistema de reservas (LobbyPMS) en tiempo real
- Crea reservas directamente si el cliente quiere
- Procesa pagos
- Se programa para recontactar (ej: "¿Cómo estuvo tu visita?")

Corre en **Fly.io** (servidor en la nube), conectado a:
- **Supabase**: base de datos de clientes, reservas, planes
- **LobbyPMS**: sistema de hospedería donde se crean las reservas de verdad
- **OpenRouter**: IA que contesta (Claude, GPT, etc.)
- **YCloud**: API de WhatsApp

---

## Los 3 pasos para participar

### 1. Clonar y correr localmente

```bash
git clone https://github.com/DanpaDevJulita/bot-lajulita.git
cd bot-lajulita
npm install

# Crear .env (pídele las credenciales a Daniel o tu jefe)
cp .env.example .env
# Editar .env con: OPENROUTER_API_KEY, SUPABASE_URL, etc.

# Terminal 1: correr el web (recibe mensajes)
npm run web

# Terminal 2: correr el worker (procesa turnos)
npm run worker
```

Ahora el bot escucha en `http://localhost:8080`. Probá enviando un mensaje desde WhatsApp o usa un cliente HTTP.

---

### 2. Entender la estructura

**Archivos que necesitás conocer:**

| Ruta | Qué es |
|---|---|
| `src/agentes/` | Los agentes del bot (ventas, soporte, etc.). Cada uno tiene `agente.ts`, `herramientas.ts` y `prompt.md` |
| `src/web/start.ts` | Express: recibe webhooks de WhatsApp y Bold |
| `src/worker/start.ts` | BullMQ: procesa colas de mensajes |
| `src/core/ai/runTurn.ts` | La lógica central: corre un turno del bot |
| `src/integraciones/` | Conexiones a YCloud, LobbyPMS, Bold, etc. |
| `.env.example` | Template de variables de entorno |
| `fly.toml` | Configuración de Fly.io (producción) |
| `CLAUDE.md` | Este archivo. Lo lee Claude Code automáticamente. |

**Flujo de un mensaje:**

```
1. Usuario escribe en WhatsApp
2. YCloud manda webhook a bot: POST /webhooks/whatsapp
3. Express lo valida y encola en Redis
4. BullMQ worker lo lee
5. runTurn() carga el historial del cliente y elige agente
6. Agente corre sus herramientas (consulta BD, llama LobbyPMS, etc.)
7. Agente genera respuesta con IA (OpenRouter)
8. Bot envía respuesta por WhatsApp (YCloud)
9. Estado del cliente se guarda en Supabase
```

---

### 3. Hacer un cambio

Ejemplo: agregar una pregunta frecuente nueva.

**Paso 1:** Editá `src/agentes/ventas/prompt.md` y agregá la pregunta.

**Paso 2:** Testea localmente — envía un mensaje a tu número de prueba.

**Paso 3:** Commitea:
```bash
git add src/agentes/ventas/prompt.md
git commit -m "Agregar FAQ: cómo es el check-in"
```

**Paso 4:** Despliega a Fly:
```bash
npm run deploy
```

**Paso 5:** Mirá los logs:
```bash
npm run logs
# Elige "worker" en la lista
```

---

## Las herramientas que el bot puede ejecutar

Cada agente tiene herramientas. Por ejemplo, el agente "ventas":

| Herramienta | Qué hace |
|---|---|
| `consultar_planes` | Trae precios y descripción de planes desde Supabase |
| `consultar_disponibilidad` | Pregunta a LobbyPMS si hay lugar para esa fecha |
| `crear_reserva` | Crea una reserva en LobbyPMS y Bold (si está permitido) |
| `verificar_cifras` | Asegura que los montos coincidan |

Cuando el agente decide usar una herramienta, la ejecuta (no es que el cliente la invoque). Es el agente quien decide.

---

## Cosas raras que van a pasar

### El bot es offline por un rato
- Probablemente estoy desplegando (2-3 min)
- O hay un error que hizo que el worker muera
- Mirar logs: `npm run logs`

### LobbyPMS devuelve error 403
- Significa que la IP del bot no está autorizada en LobbyPMS
- La IP debe ser `209.71.78.239`
- Ver: https://docs.lajulitadev.com/infraestructura-lobbypms-ip.md

### Un comando no funciona
- Probablemente necesita permisos
- Los comandos especiales (`/corrige`, `/aprende`, `/reset`) solo funcionan si estás en `OWNER_WHATSAPP_NUMBERS` o `TEAM_LOGIN_USERS`

### Redis está lento
- Upstash tiene ~240ms de latencia desde Fly (normal, está en USA)
- Si es crítico, cambiar a Redis en Fly (más caro, menos latencia)

---

## Comandos útiles

```bash
npm run deploy          # Desplegar cambios a Fly (2-3 min)
npm run logs            # Ver logs en vivo del worker
npm run estado          # Ver máquinas, CPU, RAM en Fly

git status              # Ver qué archivos cambiaste
git diff                # Ver qué cambió en cada archivo
git log --oneline       # Ver commits recientes

flyctl ssh console      # Entrar a una máquina de Fly (modo shell)
```

---

## Si querés profundizar

- **Arquitectura completa:** `DEPLOY-FLY-IO.md`
- **Cómo LobbyPMS conecta:** `INFRAESTRUCTURA-lobbypms-ip.md`
- **Documentación de agentes:** `documentation/`
- **Cambios recientes:** `git log` o GitHub

---

## Credenciales y secretos

**NUNCA commitees credenciales.** Viven en:

- **Localmente:** archivo `.env` (que está en `.gitignore`)
- **En Fly:** `fly secrets list --app botlajulita` (cifradas, nunca visibles)

Si necesitás una credencial que no está en `.env`, preguntale a Daniel.

---

## ¿Me contacto con alguien?

- **Problemas técnicos / dudas del código:** Daniel (daniel.pataquiva@lajulitadevelopment.site)
- **Issues del bot:** GitHub issues en el repo, o `/corrige` desde WhatsApp
- **Cambios de BD:** Daniel prefiere que se hagan por SQL Editor de Supabase

---

## Próximo paso

Abre la carpeta en **Claude Code** (el editor que estás usando). Automáticamente va a leer este archivo (`CLAUDE.md`) y va a tener contexto completo del proyecto.

**Ahora sí, bienvenido. ¡A trabajar!**
