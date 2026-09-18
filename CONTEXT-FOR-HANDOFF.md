# Contexto Completo del Proyecto — Para Sesión Remota

**Propósito:** Este documento contiene TODO lo que necesitas para trabajar sobre el Bot La Julita desde cualquier máquina, en cualquier sesión de Claude. Cópialo y pégalo en tu chat.

---

## 📋 Resumen del Proyecto

**Bot de WhatsApp para La Julita** (hospedería/glampings en Colombia).

**Qué hace:**
- Contesta preguntas sobre planes y precios
- Consulta disponibilidad en LobbyPMS (sistema de reservas) en tiempo real
- Crea reservas directamente si el cliente quiere
- Procesa pagos con Bold
- Se programa para enviar mensajes automáticos (recontactos)
- Maneja errores y aprende de correcciones que le haga el admin

**Stack técnico:**
- Node.js 24 + TypeScript
- Express (webhooks)
- BullMQ (colas de trabajo)
- Supabase (PostgreSQL)
- Redis Upstash (colas)
- OpenRouter (IA: Claude, GPT, etc.)
- YCloud (WhatsApp API)
- Fly.io (hosting)

---

## 🔑 Acceso a servicios

**IMPORTANTE:** Para deployar cambios o ver logs, necesitas acceso a Fly.io. El usuario que abrió este documento tiene acceso. Si necesitás hacer cambios, coordina con él.

| Servicio | URL | Propósito |
|---|---|---|
| **Fly.io** | https://fly.io/apps/botlajulita | Servidor donde corre el bot (web + worker) |
| **Supabase** | https://supabase.com/dashboard | Base de datos (clientes, reservas, planes) |
| **GitHub** | https://github.com/DanpaDevJulita/bot-lajulita | Repositorio del código |
| **OpenRouter** | https://openrouter.ai | API de IA (Claude, GPT, etc.) |
| **YCloud** | https://console.ycloud.com | WhatsApp API |
| **LobbyPMS** | https://api.lobbypms.com | Sistema de hospedería (consultas de disponibilidad) |
| **Upstash** | https://console.upstash.com | Redis remoto (colas de trabajo) |

---

## 🚀 Estado actual (18 de septiembre de 2026)

✅ Bot en producción en Fly.io
✅ Procesa mensajes de verdad (webhooks de YCloud funcionando)
✅ Consulta disponibilidad en LobbyPMS (IP `209.71.78.239` autorizada)
✅ Crea reservas y procesa pagos
✅ Worker procesa colas de recontactos
✅ Escalado automático configurado
✅ Logs visible en Grafana (7 días de retención)

**URL pública:** https://botlajulita.fly.dev

---

## 📁 Cómo el código está organizado

```
src/
├── web/                    # Express: recibe webhooks
│   ├── start.ts           # Servidor HTTP
│   └── routes/
│       ├── webhooks.ts    # POST /webhooks/whatsapp, /webhooks/bold
│       └── health.ts      # GET /health
│
├── worker/                 # BullMQ: procesa colas
│   └── start.ts           # Worker que escucha Redis
│
├── core/
│   ├── agentes/           # Cada agente es una IA especializada
│   │   ├── ventas/
│   │   │   ├── agente.ts        # Define al agente
│   │   │   ├── herramientas.ts  # Sus funciones
│   │   │   └── prompt.md        # Su sistema prompt (instrucciones de IA)
│   │   └── soporte/
│   │       └── (similar)
│   │
│   ├── db/                # Acceso a Supabase
│   │   └── supabase.ts
│   │
│   ├── llm/               # OpenRouter
│   │   └── openrouter.ts
│   │
│   ├── ai/                # Orquestación
│   │   └── runTurn.ts     # Ejecuta un turno completo del bot
│   │
│   └── ...
│
└── integraciones/
    ├── ycloud.ts          # Enviar mensajes por WhatsApp
    ├── bold.ts            # Procesar pagos
    ├── lobbypms.ts        # Consultar disponibilidad
    └── ...
```

**Lo importante:** Los agentes se descubren automáticamente. El bot escanea `src/agentes/*/agente.ts` al arrancar.

---

## 🔄 Flujo de un mensaje

```
1. Usuario escribe en WhatsApp
   ↓
2. YCloud manda webhook: POST https://botlajulita.fly.dev/webhooks/whatsapp
   ↓
3. Express valida y encola en Redis (Upstash)
   ↓
4. BullMQ worker lee la cola
   ↓
5. runTurn() carga:
   - Historial del cliente (desde Supabase)
   - Elige el agente (ventas, soporte, etc.)
   ↓
6. Agente ejecuta herramientas:
   - consultar_planes → consulta Supabase
   - consultar_disponibilidad → llama LobbyPMS
   - consultar_faq → busca en BD
   ↓
7. Agente pregunta a OpenRouter (IA): "¿Qué le digo al cliente?"
   ↓
8. IA responde
   ↓
9. Bot envía respuesta: POST a YCloud → WhatsApp
   ↓
10. Estado del cliente se guarda en Supabase
```

---

## 🛠️ Cómo deployar cambios

**El código está en GitHub.** El usuario que te pasó esto tiene acceso a Fly.io y puede deployar.

**Si quieres sugerir cambios:**
1. Decile exactamente qué archivo cambiar y qué líneas
2. Él hace el cambio y corre:
   ```bash
   git add .
   git commit -m "tu mensaje"
   npm run deploy
   ```
3. Tarda 2-3 minutos en vivo
4. Para ver los logs: `npm run logs` (abre lista, elige "worker")

**Si quieres ver los logs desde aquí:**
Pídele al usuario que corra `npm run logs` y que te muestre la terminal. Ahí verás exactamente qué está pasando.

---

## 📊 Base de datos (Supabase)

**Tablas principales:**

| Tabla | Contenido |
|---|---|
| `plans` | Servicios, precios, descripción |
| `disponibilidad` | Fechas libres/bloqueadas |
| `usuarios` | Clientes que chatean con el bot |
| `reservas` | Bookings (creadas por bot o panel) |
| `pagos` | Transacciones Bold |
| `mensajes` | Historial de conversaciones (auditoría) |
| `estado_conversacion` | Dónde está en el flujo cada cliente |
| `tickets` | Errores reportados y learning del bot |

**Cambios de esquema:** Se hacen por SQL Editor de Supabase (no migraciones).

---

## 🎯 Comandos especiales que el bot reconoce

Solo funcionan si el usuario está en `OWNER_WHATSAPP_NUMBERS` o tiene permisos especiales:

| Comando | Qué hace |
|---|---|
| `/corrige <descripción>` | Reporta un error, crea ticket en BD |
| `/aprende <pregunta> → <respuesta>` | Enseña al bot una respuesta nueva |
| `/reset` | Borra todo del cliente (reservas, historial, estado) — requiere confirmación en 15 min |

---

## 🐛 Troubleshooting

### "El bot no contesta"
1. ¿YCloud está enviando webhooks? Mirar logs
2. ¿El worker está corriendo? Mirar estado en Fly
3. ¿Hay errores de OpenRouter? Mirar logs del worker

### "LobbyPMS devuelve 403 (IP no autorizada)"
1. La IP debe ser `209.71.78.239`
2. Verificar en LobbyPMS panel: Configuraciones → API → Restricciones
3. Si cambió, actualizar en LobbyPMS

### "Redis está lentísimo"
- Upstash tiene ~240ms de latencia (está en USA, bot en Brasil)
- Es normal, no es error

### "Máquina se murió / no hay logs"
- Ver "Logs from Previous Starts" en Fly
- Probablemente error de IA o timeout de LobbyPMS

---

## 📝 Variables de entorno críticas

El bot necesita estos valores en `.env` (localmente) o en `fly secrets` (producción):

- `OPENROUTER_API_KEY` — para llamar a IA
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — base de datos
- `YCLOUD_ACCOUNT_ID`, `YCLOUD_API_KEY` — WhatsApp
- `REDIS_URL` — Upstash
- `BOLD_API_KEY` — pagos
- `LOBBYPMS_BASE_URL`, `LOBBYPMS_API_KEY` — consultas de disponibilidad
- `OWNER_WHATSAPP_NUMBERS` — números autorizados para /corrige, /aprende
- `YCLOUD_DRY_RUN` — false en producción (contesta de verdad)
- `CREAR_RESERVA_DESDE_BOT` — true si puede crear reservas automáticamente

**Nunca** compartir estos valores por chat. Viven solo en archivos `.env` (excluido de git).

---

## 🚢 Deployar desde Fly.io

Si tienes acceso a Fly.io, puedes ver y controlar:

```bash
# Ver máquinas corriendo
flyctl status --app botlajulita

# Ver logs en vivo
flyctl logs --app botlajulita

# Desplegar cambios
flyctl deploy --app botlajulita --remote-only

# Ver versiones desplegadas
flyctl releases --app botlajulita

# Volver a versión anterior
flyctl deploy --app botlajulita --image registry.fly.io/botlajulita:deployment-XXXXX
```

---

## 💰 Costos mensuales (18 de septiembre de 2026)

| Concepto | Costo |
|---|---|
| Fly.io web (512MB) | $3.19 |
| Fly.io worker (1GB) | $5.70 |
| IP estática para LobbyPMS | $3.60 |
| Redis Upstash | $10-20 |
| **Total** | **~$22-32/mes** |

---

## ✅ Lo que necesitas saber para trabajar aquí

1. **Código:** GitHub (rama `BotDevelopment`)
2. **Producción:** Fly.io (https://botlajulita.fly.dev)
3. **Base de datos:** Supabase (PostgreSQL)
4. **Deployar:** Usuario con acceso a Fly necesita hacer `npm run deploy`
5. **Ver qué pasa:** `npm run logs` abre los logs en vivo
6. **Cambios de esquema:** SQL Editor de Supabase (no migraciones)
7. **Errores:** Revisar logs del worker, ahí aparece todo

---

## 🎓 Próximo paso

1. Abre este documento en Claude Code (la herramienta que estás usando)
2. Pregunta lo que necesites — tengo contexto completo
3. Si necesitas hacer cambios en código, dímelo y coordino con quien tiene acceso a Fly
4. Si necesitas ver logs, pídele al usuario que corra `npm run logs` y me muestre

---

## 📞 Contacto

- **Usuario que abrió el proyecto:** Daniel (daniel.pataquiva@lajulitadevelopment.site)
- **Repo GitHub:** https://github.com/DanpaDevJulita/bot-lajulita
- **Rama actual:** BotDevelopment
- **Último commit:** a90b3ef (Atajos npm para desplegar y ver logs en Fly)

---

**Fin del contexto. Ahora sí, ¡a trabajar!**
