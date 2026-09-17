# Parche para LaJulitaWeb — usuarios que pueden corregir el bot (2026-09-16)

Qué agrega en el panel: en **Usuarios**, un campo **Celular (WhatsApp)** y una casilla
**"Puede corregir el bot por WhatsApp"**. Con la casilla marcada, el usuario activo y su celular
cargado, el bot (bot-lajulita) le acepta desde ese número:

- `corrige <falla>` — texto o nota de voz → abre un ticket en Tickets.
- `/aprende <regla>` — le enseña algo al bot y deja un ticket ya resuelto como historial.

Si el usuario se inhabilita en el panel, pierde el permiso solo.

## Archivos (rutas relativas a la raíz de LaJulitaWeb)

| Archivo | Qué hacer |
|---|---|
| `database/migrations/2026_09_16_000030_add_bot_corrige_to_users_table.php` | copiar (nuevo) |
| `app/Models/User.php` | reemplazar o mergear: agrega `celular` y `bot_puede_corregir` a `$fillable` y el cast booleano |
| `app/Http/Controllers/Admin/UsuarioController.php` | reemplazar o mergear: validación de celular, guardado de la marca, bitácora, y manejo de "celular repetido" |
| `resources/views/admin/usuarios/_campos.blade.php` | reemplazar o mergear: campo celular + casilla |
| `resources/views/admin/usuarios/index.blade.php` | reemplazar o mergear: columnas Celular y Bot en la tabla |

Los cuatro archivos existentes se generaron a partir de la copia `panel-admin-laravel.zip` que hay
en este repo. Si en LaJulitaWeb cambiaron desde entonces, **mergear** en vez de reemplazar: cada
cambio está marcado con un comentario `[2026-09-16]` para ubicarlo rápido.

## Base de datos — correr UNA sola de estas dos opciones

1. `php artisan migrate` en LaJulitaWeb (queda versionado allá), **o**
2. `sql/users-bot-corrige.sql` de este repo en el SQL Editor de Supabase.

Hacen exactamente lo mismo (columnas `celular`, `celular_clave` generada, `bot_puede_corregir`,
índices y el grant por columna al rol `bot_lajulita`). Son idempotentes.

## Después

- Marcar a las personas en Usuarios y cargarles el celular.
- Las variables `OWNER_WHATSAPP_NUMBERS` y `REPORTE_FALLAS_NUMBERS` del `.env` del bot quedan
  solo como respaldo; se pueden vaciar cuando todos estén marcados en el panel.
- El bot cachea el permiso un minuto: una marca nueva se nota, como mucho, un minuto después.
