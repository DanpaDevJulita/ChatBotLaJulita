# Informe: Conexión API LobbyPMS y prompt de disponibilidad (n8n)

> Extraído del n8n de La Julita (`https://n8n-n8n.dvbneu.easypanel.host`) para reutilizar en el nuevo bot.
> Fecha de extracción: 9 de septiembre de 2026.

---

## 1. Workflow "Availability" — estructura general

Workflow: **Availability** (`/workflow/kVuk22RDIQCdgTa8`)

```
When chat message received (Chat Trigger)
        │
        ▼
      Today (Code node, JS)
        │
        ▼
     AI Agent (Tools Agent) ──┬── Chat Model: OpenAI Chat Model (gpt-4o)
                               ├── Memory: Window Buffer Memory
                               └── Tool: AVAILABILITY (HTTP Request Tool → LobbyPMS)
```

- **Trigger**: `When chat message received` (Chat Trigger de n8n).
- **Nodo "Today"** (Code / JavaScript, "Run Once for All Items"): calcula la fecha/hora de referencia que usa el prompt del agente.
- **AI Agent**: tipo *Tools Agent* (LangChain), con modelo, memoria y una tool conectados.
- **Modelo**: OpenAI Chat Model → modelo **`gpt-4o`**, credencial **"OpenAi account 2"**.
- **Memoria**: **Window Buffer Memory** (memoria de ventana deslizante, configuración por defecto — memoria de la conversación por sesión de chat).
- **Tool**: **AVAILABILITY** → HTTP Request Tool que llama a la API de LobbyPMS.

### Nodo "Today" (código JavaScript)

Este nodo genera las variables de fecha/hora que el prompt del agente usa como referencia (`currentDay`, `currentDate`, `currentYear`):

```javascript
const today = new Date();
const currentYear = today.getFullYear();
const currentDate = today.toISOString().split("T")[0]; // YYYY-MM-DD

const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const currentDay = days[today.getDay()];

return [{ currentYear, currentDate, currentDay }];
```

---

## 2. Conexión API con LobbyPMS (tool "AVAILABILITY")

Nodo **HTTP Request Tool** llamado `AVAILABILITY`, conectado como *Tool* del AI Agent.

| Parámetro | Valor |
|---|---|
| **Método** | `GET` |
| **URL** | `https://api.lobbypms.com/api/v1/available-rooms` |
| **Authentication** | `None` (la autenticación va por query param, no por el mecanismo de auth de n8n) |
| **Send Query Parameters** | `ON` — "Using Fields Below" |
| **Send Headers** | `OFF` |
| **Send Body** | `OFF` |
| **Optimize Response** | `OFF` |

### Query Parameters

| Nombre | Origen del valor | Valor |
|---|---|---|
| `api_token` | Fijo ("Using Field Below") | `<REDACTADO — el token real va SOLO en .env como LOBBYPMS_API_TOKEN>` |
| `start_date` | **"By Model"** (obligatorio) — lo completa el agente de IA según la fecha solicitada por el usuario |
| `end_date` | **"By Model"** (obligatorio) — lo completa el agente de IA (día de salida) |

> ⚠️ El `api_token` es una credencial sensible de la cuenta de LobbyPMS de La Julita. Trátalo como secreto (no lo publiques en repos públicos ni lo compartas fuera del equipo) al configurarlo en el nuevo bot.

### Descripción de la tool (la que ve el modelo de IA)

Este es el texto de "Description" configurado en el nodo, que le explica al agente qué hace la tool y qué formato de datos devuelve:

```
consulta la disponibilidad de habitaciones.
se debe consultar únicamente la disponibilidad como en el siguiente ejemplo:

{
"date":
"2025-08-28",
"name":
"CHALET",
"available_rooms":
1
},
{
"date":
"2025-08-28",
"name":
"DOMO ROMANTIC",
"available_rooms":
2
}
```

Es decir, la API de LobbyPMS responde con un arreglo de objetos `{ date, name, available_rooms }` por cada tipo de habitación y fecha dentro del rango consultado.

### Tipos de habitación identificados

A partir del prompt y de los ejemplos de la tool, los tipos de habitación que maneja el hotel/glamping son:

- Chalet
- Domo Romantic
- Domo Deluxe
- Domo Familiar

---

## 3. Prompt del agente (System Message) — todo lo referente a disponibilidad

Este es el **System Message completo** del nodo `AI Agent` del workflow "Availability" (texto exacto, incluyendo las expresiones `{{ }}` que inyecta n8n):

```
Tu tarea es interpretar la solicitud de fechas del usuario y devolver la disponibilidad en el formato indicado.

Reglas de interpretación de fechas:
* Usa como referencia el día actual con {{ $json.currentDay }}, la fecha actual con {{ $json.currentDate }} y el año actual con {{ $json.currentYear }}.
* Si el usuario menciona "hoy", la fecha de inicio (start_date) debe ser {{ $json.currentDate }}.
* Si el usuario menciona un día de la semana (ej. sábado), debes calcular la próxima ocurrencia de ese día a partir de la fecha actual.
* Si el usuario no especifica el año, asume siempre el año actual ({{ $json.currentYear }}).
* La fecha final (end_date) corresponde al día de salida del huésped, por lo tanto **NO se debe mostrar disponibilidad de ese día**.
* Si la entrada es solo una fecha, asume que es 1 noche (start_date y end_date = día siguiente).
* Si el rango es exactamente de 1 noche (ejemplo: 30 de agosto al 31 de agosto), solo devuelve la disponibilidad del día de entrada.
* Calcula y muestra en la cabecera cuántos días y cuántas noches incluye la disponibilidad, donde:
  - días = (end_date - start_date en días) + 1
  - noches = días - 1

Formato de salida:
* Solo texto plano (no JSON).
* Claro para WhatsApp, con saltos de línea y emojis.
* Encabezado:
  - Si es más de 1 noche:
    "Disponibilidad:
    X días, Y noches"
  - Si es 1 sola noche:
    "Disponibilidad una noche:"
* Luego lista cada día incluido en la disponibilidad (sin el end_date) en este formato:

📅 [día de la semana] [día de mes] de [mes] [año]
- Chalet: [número]
- Domo Romantic: [número]
- Domo Deluxe: [número]
- Domo Familiar: [número]
```

**Notas sobre las variables inyectadas** (vienen del nodo "Today", ver sección 1):
- `{{ $json.currentDay }}` → nombre del día actual en español (ej. "martes").
- `{{ $json.currentDate }}` → fecha actual en formato `YYYY-MM-DD`.
- `{{ $json.currentYear }}` → año actual (número).

### Mensaje de usuario (input del agente)

El campo "Text" (User Message) del AI Agent es:

```
{{ $('When chat message received').item.json.chatInput }}
```

Es decir, el agente recibe directamente el texto que el usuario escribió en el chat/WhatsApp.

---

## 4. Workflow "EVOLUTION AI AGENT" (bot principal de WhatsApp)

> ⏳ **Pendiente** — la sesión de n8n en Chrome se cerró antes de poder abrir este workflow. Según la lista de workflows, este es probablemente el agente principal que atiende WhatsApp (vía Evolution API) e invoca al workflow "Availability" como sub-workflow/tool. Falta confirmar:
> - Su System Message / prompt general.
> - Cómo invoca a la tool o sub-workflow de disponibilidad (Execute Workflow Tool vs. HTTP Tool directo).
> - Si repite o referencia las mismas reglas de fecha/formato ya documentadas arriba.
>
> Se completará esta sección en cuanto se restablezca el acceso.

---

## 5. Resumen para el nuevo bot

Para replicar esta funcionalidad de disponibilidad en el nuevo bot, se necesita:

1. **Una tool HTTP GET** a `https://api.lobbypms.com/api/v1/available-rooms` con query params `api_token` (fijo, ver sección 2), `start_date` y `end_date` (calculados por el modelo).
2. **Un nodo previo que calcule la fecha/hora actual** (día de la semana, fecha ISO, año) para dárselo como contexto al modelo — o el equivalente en la plataforma del nuevo bot.
3. **El system prompt de la sección 3**, con sus reglas de interpretación de fechas y el formato de salida en texto plano para WhatsApp, listando los 4 tipos de habitación (Chalet, Domo Romantic, Domo Deluxe, Domo Familiar).
4. **Modelo**: se usó `gpt-4o` de OpenAI; se puede mantener u optimizar según el proveedor del nuevo bot.
