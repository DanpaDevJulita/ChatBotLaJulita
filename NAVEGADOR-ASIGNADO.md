# Navegador de Chrome asignado a Claude

**Fijado el 2026-09-09 por Daniel.** Todo el trabajo con navegador va SIEMPRE en este Chrome.

| Dato | Valor |
|---|---|
| `deviceId` | `36604e26-a66e-4077-b0a1-c206f4edd871` |
| Nombre que le puso el usuario | **PersonalDevelopment** |
| Sistema | Windows |

## Instrucción para cualquier sesión futura de Claude

Antes de la primera acción de navegador, llamar directo:

    select_browser({ deviceId: "36604e26-a66e-4077-b0a1-c206f4edd871" })

No hace falta volver a preguntar cuál usar: ya está decidido. Solo se pregunta de nuevo si esa
llamada falla (ese Chrome cerrado, extensión desconectada), y en ese caso se le avisa al usuario
en vez de elegir otro por cuenta propia.

## Por qué hace falta anotarlo

- El **nombre** que muestra la extensión NO es confiable: se reinicia a "Browser 1/2/3" según el
  orden de conexión, y ese orden cambia en cada reconexión. En una misma tarde los mismos dos
  navegadores aparecieron con los nombres invertidos.
- El **`deviceId` sí es estable**: es por perfil de Chrome y no cambia entre reconexiones.
- La selección **no sobrevive a una conversación nueva**: hay que volver a llamar
  `select_browser` al empezar. Por eso el id queda escrito acá.

## Otros navegadores conectados (NO usar salvo pedido expreso)

- `77e82fd3-59fd-4c80-b87d-b5a335fd0c9f`
- `1bccf4de-da45-481c-b265-a629b186fe09`

Uno de esos dos tiene la sesión de **Kommo** (cuenta `lajulitaglamping`), la que se usó el
2026-09-08 para leer el embudo y las conversaciones. No quedó identificado cuál: si hace falta
volver a Kommo, confirmarlo con el usuario antes de asumir.

## Límite a recordar

Dentro de cualquier navegador la extensión solo permite ver y usar **las pestañas del grupo de
Claude**. Las que el usuario ya tenga abiertas no son accesibles: hay que pedirle la dirección y
abrirla en una pestaña propia (la sesión del perfil se comparte, así que los logins siguen
valiendo).
