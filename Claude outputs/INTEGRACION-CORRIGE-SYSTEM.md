# Sistema de Reportes "Corrige" - Guía de Integración

**Fecha:** 2026-09-17  
**Estado:** Listo para integración (requiere verificación de nombres de columnas)

---

## Resumen Ejecutivo

El sistema permite que usuarios autorizados del panel reporten fallas del bot usando el prefijo "corrige", creando tickets automáticos en Supabase. La autorización se gestiona a través de la tabla `users` del panel, con fallback a `.env` para casos legales.

---

## Componentes Entregados

### 1. Base de Datos (`sql/users-bot-corrige.sql`)

Añade a la tabla `users`:
- **`celular`** (text): Número de teléfono del usuario
- **`bot_puede_corregir`** (boolean, default false): Marca si el usuario puede reportar fallas/enseñar
- **`celular_clave`** (generated column): Últimos 10 dígitos para matching rápido

**Índices creados:**
- `idx_users_celular_clave` (unique): Búsqueda por teléfono
- `idx_users_bot_puede_corregir`: Optimización de queries

**Permisos:**
- `bot_lajulita` role: SELECT en (id, name, activo, celular_clave, bot_puede_corregir)

---

### 2. Repositorios TypeScript

#### `src/core/db/ticketsRepo.ts`
Funciones para crear tickets:

```typescript
// Ticket de falla reportada (nuevo)
abrirTicketReportado(
  texto: string,
  reportadoPor: string, 
  canal: "whatsapp" | "sms" | "telegram",
  externalId: string,
  medio: "texto" | "audio"  // Nuevo: registra si fue voz o texto
): Promise<{ id?: number; error?: string }>

// Ticket de enseñanza (nuevo)
abrirTicketEnsenanza(
  entrada: string,
  reportadoPor: string,
  correccionId: number,
  canal?: string
): Promise<{ id?: number; error?: string }>

// Ticket técnico (existente - compatible)
abrirTicketTecnico(entrada: string, reportadoPor?: string)
```

#### `src/core/db/usuariosPanelRepo.ts` (NUEVO)
Sistema de permisos con caché:

```typescript
permisosDeNumero(numeroWhatsApp: string): Promise<PermisosNumero | null>
// Retorna: { nombre, puedeReportar, puedeEnsenar }
// - Consulta primero la tabla users (panel)
// - Cachea por 1 minuto para reducir queries DB
// - Retorna null si falla (fallback a .env)

// Herramientas de testing:
olvidarCachePermisos(numeroWhatsApp: string)
olvidarTodoCache()
```

---

### 3. Flujos en `src/core/pipeline/comandos.ts`

#### Regex de Detección
```typescript
const PREFIJO_REPORTE = /^[\s"'""¡!¿?.,;:\-–—]*\/?\s*(corrige|corrija|corregir|corrígeme|corrigeme)\b[\s"'"".,;:\-–—]*/i;
```

Acepta: `"corrige"`, `"Corrige,"`, `"/corrige:"`, `"corrija"`, `"corrígeme"`, `"corrigeme"`

#### Hook: Antes del chequeo de comandos `/`
```typescript
// En intentarComando(), ANTES de la lógica de `/comando`:

if (PREFIJO_REPORTE.test(texto)) {
  const reporte = extraerReporteDeFalla(texto);
  if (reporte && (await puedeReportarFalla(externalId))) {
    const resultado = await abrirTicketReportado(
      reporte,
      externalId,
      "whatsapp",
      externalId,
      medio  // "texto" o "audio"
    );
    
    if (resultado.id) {
      await ctx.send(`✅ Reporte #${resultado.id} registrado`);
      return; // Detener aquí
    }
  }
}

// Luego: lógica normal de comandos /corrige, /aprende, etc.
```

#### Modificación: Comando `/aprende`
```typescript
// Después de guardar la regla de corrección:
if (guardada.id) {
  await abrirTicketEnsenanza(
    `Regla: ${guardada.patrón} → ${guardada.respuesta}`,
    externalId,
    guardada.id ?? 0,
    "whatsapp"
  );
}
```

---

### 4. Modificación a `src/core/pipeline/runTurn.ts`

Cambiar la firma de `intentarComando`:

```typescript
// ANTES:
intentarComando(texto: string, ...)

// DESPUÉS:
intentarComando(texto: string, medio: "texto" | "audio", ...)

// Al llamar, pasar:
// - medio = "texto" si vino de texto
// - medio = "audio" si vino de audio/transcripción
```

---

## Flujo de Datos

```
Usuario autorizado envía: "corrige el bot no responde"
        ↓
Bot detecta PREFIJO_REPORTE
        ↓
Bot extrae: "el bot no responde"
        ↓
Bot consulta: ¿puedeReportarFalla(externalId)?
        ├─ Base de datos (users table)
        └─ .env REPORTE_FALLAS_NUMBERS (fallback)
        ↓
Si autorizado:
  - Crea ticket en tabla `tickets` con origen='reportado'
  - Registra medio (texto/audio)
  - Responde: "✅ Reporte #123 registrado"
  ↓
Si NO autorizado:
  - Ignora el prefijo
  - Continúa procesamiento normal
```

---

## Configuración de Autorización

### Opción 1: Panel (RECOMENDADO - Dinámico)
1. En LaJulitaWeb, ir a usuarios
2. Editar usuario → llenar campo **Celular**
3. Marcar ✓ **Bot puede corregir**
4. Guardar

**Ventaja:** Sin redeploy, cambios inmediatos  
**Validación:** El panel debe hacer regex en celular (ej: `^\+57[0-9]{10}$`)

### Opción 2: .env (Fallback Legal)
```env
REPORTE_FALLAS_NUMBERS=+573001234567,+573009876543
PUEDEENSENAR_NUMBERS=+573001234567
```

**Cuándo aplica:** Si DB query falla o usuario no está en tabla  
**Ventaja:** Control absoluto, no depende de BD

---

## Columnas Esperadas en Tabla `users`

**IMPORTANTE:** Verifica que tus columnas se llamen así:
- `celular` → Si es distinto, cambiar en `usuariosPanelRepo.ts` línea ~47
- `bot_puede_corregir` → Si es distinto, cambiar en línea ~47
- `activo` → Si es distinto, cambiar en línea ~47
- `name` (o `nombre`) → Si es distinto, cambiar en línea ~47

**Archivo a editar:** `src/core/db/usuariosPanelRepo.ts`

```typescript
const { data, error } = await supabase
  .from("users")
  .select("id, nombre:name, activo, bot_puede_corregir")  // ← VERIFICAR ESTOS NOMBRES
  .eq("celular_clave", clave)
  .eq("activo", true)
  .eq("bot_puede_corregir", true)
  .single();
```

---

## Tabla de Tickets: Campos Afectados

Los tickets reportados llenan:
- **`entrada`**: Texto del reporte (después del "corrige")
- **`reportado_por`**: El externalId (número WhatsApp)
- **`canal`**: "whatsapp" (hardcoded, o parametrizar)
- **`external_id`**: El número que llamó
- **`origen`**: "reportado" (o enum correspondiente)
- **`estado`**: "abierto"
- **`medio_entrada`**: "texto" o "audio" (NUEVO)
- **`created_at`**: Timestamp actual
- **`clave_bot`** (para /aprende): "aprende:123" (ID de corrección)

---

## Instalación Paso a Paso

### 1. SQL (Supabase)
```bash
# Copiar contenido de sql/users-bot-corrige.sql
# Ir a: Supabase → SQL Editor → New Query
# Pegar y ejecutar
# Esperar confirmación (sin errores)
```

### 2. TypeScript
```bash
# Crear/reemplazar archivos:
src/core/db/ticketsRepo.ts          # Nueva versión con abrirTicketReportado
src/core/db/usuariosPanelRepo.ts    # NUEVO
src/core/pipeline/comandos.ts       # Añadir hook + helpers

# Editar:
src/core/pipeline/runTurn.ts        # Cambiar firma intentarComando
```

### 3. Dependencias
```bash
npm install  # Si hay cambios en package.json
```

### 4. TypeCheck
```bash
npm run typecheck  # Verificar compilación
# Errores esperados: TS2322 en correccionId si Correccion.id es optional
# Fix: Usar guardada.id ?? 0 en abrirTicketEnsenanza
```

### 5. Testing
```bash
# Crear usuario de prueba:
# Panel → Usuarios → Nuevo
# Nombre: "Test Bot Corrige"
# Celular: "+573001234567"
# Bot puede corregir: ✓

# En bot, simular mensaje:
# externalId = "573001234567" (sin +)
# texto = "corrige el bot no responde bien"
# Verificar: ticket creado en tabla tickets
```

---

## Fallback: .env sin Base de Datos

Si por algún motivo la base de datos no está disponible, el código caerá automáticamente al `.env`:

```env
REPORTE_FALLAS_NUMBERS=+573001234567,+573009876543
```

**Nota:** La variable existe en `.env.example` documentada.

---

## Consideraciones Legales y Seguridad

1. **Permisos Supabase:** Se usa column-level grant (select específico en 5 columnas) para evitar exposición de passwords/datos sensibles.

2. **Caché:** Reduce queries en 60s window para mismo número. Configurable en usuariosPanelRepo.ts (`CACHE_TTL_MS`).

3. **Error Handling:** Todos los fallos de DB retornan null → fallback a .env. No genera excepciones no capturadas.

4. **Medio (texto/audio):** Se registra para futuro análisis. Ej: "¿Los audios reportan más fallas que textos?"

---

## Tickets Generados

### Reportes ("corrige")
| Campo | Valor |
|-------|-------|
| origen | "reportado" |
| estado | "abierto" |
| entrada | Texto después de "corrige" |
| reportado_por | externalId (número) |
| medio_entrada | "texto" o "audio" |

### Enseñanzas ("/aprende")
| Campo | Valor |
|-------|-------|
| origen | "ensenanza" |
| estado | "resuelto" |
| entrada | Descripción de la regla |
| clave_bot | "aprende:123" (ID corrección) |

---

## Debugging

### Cache no está funcionando
```typescript
// En console:
import { olvidarTodoCache } from "./db/usuariosPanelRepo.js";
olvidarTodoCache();

// Luego reintentar
```

### Usuario existe pero no se autoriza
```sql
-- Supabase SQL Editor:
SELECT id, name, celular, celular_clave, activo, bot_puede_corregir 
FROM users 
WHERE celular_clave LIKE '%1234567'; -- Últimos 7 del número
```

### Ticket no se crea
- Verificar: ¿origen='reportado' en enum de tabla tickets?
- Verificar: ¿medio_entrada existe en tabla?
- Si no: SQL fallback sin esos campos (ver code)

---

## Siguientes Pasos

- [ ] Verificar nombres de columnas en usuariosPanelRepo.ts
- [ ] Ejecutar SQL migration
- [ ] Integrar ticketsRepo y usuariosPanelRepo al proyecto
- [ ] Añadir hook "corrige" en comandos.ts
- [ ] Actualizar /aprende para crear tickets de enseñanza
- [ ] Cambiar firma de intentarComando
- [ ] npm run typecheck
- [ ] Testing local con usuario de prueba
- [ ] Deploy

---

## Preguntas Frecuentes

**P: ¿Qué pasa si el nombre de columna es "celular_usuario" en lugar de "celular"?**  
R: Editar línea 47 de usuariosPanelRepo.ts y cambiar la query `.select()`.

**P: ¿Puedo usar ambos: panel + .env?**  
R: Sí. Panel es primario, .env es fallback si DB falla.

**P: ¿Se elimina /corrige antiguo?**  
R: Sí. Antes era comando de enseñanza (`/corrige patrón → respuesta`). Ahora es solo prefijo de reporte. La enseñanza se hace con `/aprende`.

**P: ¿Los reportes deduplicados?**  
R: No. Cada "corrige" es un ticket nuevo.

**P: ¿Y si alguien abusa del sistema?**  
R: El equipo ve los tickets. Opcionalmente: limit de 5 tickets/hora por usuario.

---

**Generado:** 2026-09-17  
**Versión:** 1.0  
**Modelo:** claude-fable-5-1
