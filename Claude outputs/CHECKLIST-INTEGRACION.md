# Checklist de Integración: Sistema Corrige

## Pre-integración

- [ ] Hacer backup de base de datos Supabase
- [ ] Confirmar nombres de columnas en tabla `users` del panel
  - [ ] Columna para teléfono: `celular` (o ¿?)
  - [ ] Columna para autorización: `bot_puede_corregir` (o ¿?)
  - [ ] Columna de estado: `activo` (o ¿?)
  - [ ] Columna de nombre: `name` (o ¿?)
- [ ] Verificar rol `bot_lajulita` existe en Supabase

## Instalación Base de Datos (Supabase SQL Editor)

- [ ] Copiar `sql/users-bot-corrige.sql`
- [ ] Crear nueva query en Supabase
- [ ] Pegar y ejecutar
- [ ] Verificar sin errores
- [ ] Ejecutar query de verificación:
  ```sql
  SELECT column_name FROM information_schema.columns 
  WHERE table_name = 'users' 
  ORDER BY column_name;
  ```
- [ ] Confirmar que existen: `celular`, `bot_puede_corregir`, `celular_clave`

## Instalación TypeScript (Local)

### Paso 1: Crear archivos nuevos
- [ ] Crear `src/core/db/ticketsRepo.ts` (versión actualizada)
- [ ] Crear `src/core/db/usuariosPanelRepo.ts` (NUEVO)
- [ ] Actualizar `src/core/pipeline/comandos.ts` (añadir imports, helpers, hook)

### Paso 2: Modificar archivos existentes
- [ ] Editar `src/core/pipeline/runTurn.ts`:
  - [ ] Cambiar firma de `intentarComando()` para pasar `medio`
  - [ ] Verificar todas las calls a `intentarComando()` pasen el parámetro

### Paso 3: Verificar compilación
```bash
npm run typecheck
```
- [ ] Resolver errores de TypeScript
- [ ] Si error TS2322 en `guardada.id`: usar `guardada.id ?? 0`

### Paso 4: Dependencias
```bash
npm install
```
- [ ] Verificar no hay conflictos

## Configuración Autorización

### Opción A: Panel (Dinámico, Recomendado)
- [ ] Ir a LaJulitaWeb → Usuarios
- [ ] Crear usuario de test: "Bot Test Corrige"
- [ ] Llenar **Celular**: `+573001234567`
- [ ] Marcar ✓ **Bot puede corregir**
- [ ] Guardar

### Opción B: .env (Fallback)
- [ ] Editar `.env`
- [ ] Verificar/añadir: `REPORTE_FALLAS_NUMBERS`
- [ ] Ejemplo: `REPORTE_FALLAS_NUMBERS=+573001234567,+573009876543`

## Testing Local

### Test 1: Permisos desde BD
```typescript
// En test file o console:
import { permisosDeNumero, olvidarTodoCache } from "./src/core/db/usuariosPanelRepo.js";

olvidarTodoCache(); // Limpiar caché
const permisos = await permisosDeNumero("+573001234567");
console.log(permisos); // Debe ser: { nombre: "...", puedeReportar: true, puedeEnsenar: true }
```

- [ ] Usuarios autorizados retornan `{ puedeReportar: true, puedeEnsenar: true }`
- [ ] Usuarios no autorizados retornan `null` (fallback a .env)

### Test 2: Detección de prefijo
```typescript
// En test:
import { PREFIJO_REPORTE, extraerReporteDeFalla } from "./src/core/pipeline/comandos.js";

console.log(PREFIJO_REPORTE.test("corrige el bot no responde")); // true
console.log(extraerReporteDeFalla("corrige el bot no responde")); // "el bot no responde"
console.log(extraerReporteDeFalla("corrígeme el acento")); // "el acento"
console.log(extraerReporteDeFalla("/corrige:")); // null (empty)
```

- [ ] Acepta variantes: corrige, corrija, corrígeme, corrigeme
- [ ] Acepta punctuation/slash opcionales
- [ ] Extrae texto correctamente

### Test 3: Creación de tickets
```typescript
// En test:
import { abrirTicketReportado } from "./src/core/db/ticketsRepo.js";

const resultado = await abrirTicketReportado(
  "El bot no responde a saludos",
  "573001234567",
  "whatsapp",
  "573001234567",
  "texto"
);

console.log(resultado.id); // Número del ticket (ej: 42)
```

- [ ] Ticket se crea en tabla `tickets`
- [ ] Campo `origen` = "reportado"
- [ ] Campo `estado` = "abierto"
- [ ] Campo `medio_entrada` = "texto"
- [ ] Verificar en Supabase: SELECT * FROM tickets WHERE id = 42;

### Test 4: Flujo completo en bot
```
Bot recibe: "+573001234567 corrige no responde a emojis"
  ↓
Bot detecta "corrige" → extrae "no responde a emojis"
  ↓
Bot chequea permisos → autorizado
  ↓
Bot crea ticket → #42
  ↓
Bot responde: "✅ Reporte #42 registrado"
  ↓
Verificar en Supabase: select id, entrada, reportado_por, medio_entrada from tickets where id=42;
```

- [ ] Usuario recibe confirmación con número de ticket
- [ ] Ticket aparece en BD
- [ ] Datos correctos (entrada, reportado_por, etc.)

### Test 5: Fallback a .env
```
- Quitar usuario del panel
- Verificar que REPORTE_FALLAS_NUMBERS en .env contiene el número
- Simular mensaje "corrige..."
- Verificar que aún se autoriza y crea ticket
```

- [ ] Fallback funciona si BD no está disponible
- [ ] Mensaje llega al equipo

## Deploy

- [ ] Commit de cambios a git
- [ ] Push a rama de desarrollo
- [ ] CI/CD pipeline pasa (si existe)
- [ ] Testing en staging
- [ ] Code review aprobado
- [ ] Merge a main
- [ ] Deploy a producción
- [ ] Verificar BD migration se ejecutó en prod
- [ ] Prueba rápida con usuario real: enviar "corrige..."
- [ ] Confirmar ticket creado en BD prod

## Post-Deploy

- [ ] Documentar en onboarding del equipo:
  - [ ] "Usuarios autorizados pueden decir 'corrige' para reportar"
  - [ ] "Nuevos usuarios: ir a panel, llenar celular y marcar bot_puede_corregir"
  
- [ ] Monitorear reportes:
  - [ ] ¿Abuso? (>5 por hora)
  - [ ] ¿Falsos positivos? (gente diciendo "corrige" sin intención)

- [ ] Estadísticas (próximas 2 semanas):
  - [ ] Cuántos reportes por tipo
  - [ ] Cuántos de audio vs texto
  - [ ] Tasa de falsos positivos

## Rollback (si es necesario)

```bash
# Revertir commits
git revert <commit-id>

# En Supabase, opcionalmente:
# 1. Dejar columnas pero no usar
# 2. O ejecutar:
ALTER TABLE users DROP COLUMN bot_puede_corregir CASCADE;
ALTER TABLE users DROP COLUMN celular CASCADE;
ALTER TABLE users DROP COLUMN celular_clave CASCADE;
DROP INDEX IF EXISTS idx_users_celular_clave;
DROP INDEX IF EXISTS idx_users_bot_puede_corregir;
```

---

## Notas Importantes

**ANTES de integrar:** Verificar nombres de columnas en tu tabla `users`:
- Abrir Supabase
- Ir a `users` table
- Confirmar que tus columnas de teléfono, autorización y estado se llaman:
  - `celular` (o editar usuariosPanelRepo.ts)
  - `bot_puede_corregir` (o editar usuariosPanelRepo.ts)
  - `activo` (o editar usuariosPanelRepo.ts)
  - `name` (o editar usuariosPanelRepo.ts)

Si son distintos, actualizar línea ~47 de `usuariosPanelRepo.ts` antes de hacer commit.

---

**Generado:** 2026-09-17  
**Versión:** 1.0
