# REFERENCIA: Carousel de planes en WhatsApp (estilo Movistar)

> [2026-09-15] Pedido de Daniel: vio en el WhatsApp de Movistar Colombia un carrusel de
> tarjetas deslizables (celular + foto + precio + botón "APROVECHAR OFERTA") y quiere lo mismo
> para mandar los planes de La Julita, cada uno con su foto o video.
>
> Eso que se ve ahí NO es un mensaje normal ni un truco de bot: es un tipo de mensaje oficial
> de WhatsApp Business Platform llamado **Carousel Template** (plantilla de carrusel). Solo se
> puede mandar así — no existe una versión "libre", sin plantilla aprobada — así que hay que
> crear la plantilla una vez (con revisión de Meta) y después el bot la dispara cuantas veces
> quiera, cambiando solo los datos (fotos, precios, links).
>
> El proyecto ya habla con WhatsApp a través de **YCloud** (`src/channels/whatsapp-ycloud/`,
> ver `.env` → `YCLOUD_API_KEY`), así que toda esta guía usa la API de YCloud, no la de Meta
> directo — son compatibles en estructura, pero los endpoints y el dashboard son los de YCloud.

## 1. Lo que WhatsApp permite (reglas duras, no negociables)

| Regla | Valor |
|---|---|
| Tarjetas por carrusel | Mínimo 2, máximo 10 — y **el número queda fijo**: si la plantilla se aprueba con 5 tarjetas, cada envío tiene que mandar esas 5, no menos ni más. |
| Encabezado de cada tarjeta | Imagen **o** video — pero **todas las tarjetas del mismo carrusel tienen que usar el mismo tipo** (no se puede mezclar 2 con foto y 1 con video). |
| Texto de cada tarjeta | Opcional, pero si UNA tarjeta lo trae, TODAS tienen que traerlo. Máximo ~160 caracteres (no cabe la descripción larga que hoy manda el bot en texto — hay que resumir). |
| Botones por tarjeta | Máximo 2, y **la combinación de tipos tiene que ser igual en todas las tarjetas** (ej. todas "respuesta rápida + link", o todas "solo link"). Tipos disponibles: respuesta rápida (`quick_reply`), link (`url`, admite 1 variable), llamada (`phone_number`). |
| Categoría de la plantilla | `MARKETING` (es contenido promocional de precios/planes — Meta la clasifica así igual aunque se mande dentro de una conversación ya iniciada por el cliente). |
| Aprobación | La revisa Meta (vía YCloud) antes de poder usarla. Normalmente minutos a pocas horas, a veces hasta 24-48h. Cualquier cambio de texto/fotos de ejemplo obliga a volver a someterla — por eso el texto de cada tarjeta debe quedar genérico y las fotos/precios reales se mandan como *parámetros* en cada envío, no fijos en la plantilla. |

Fuente: documentación de Meta y de YCloud sobre carousel templates (ver enlaces al final).

## 2. Decisión: ¿foto o video en cada tarjeta?

Como las reglas obligan a que **todo el carrusel** use un solo tipo de encabezado, no se puede
poner "foto o video según lo que tenga cada plan" (eso sí se puede seguir haciendo como hoy,
fuera del carrusel, cuando el cliente pide el detalle de UN plan puntual — eso ya está resuelto
en `planes.ts` / `link_video`).

**Recomendación: arrancar con FOTO en las 10 tarjetas.** Motivos:
- Ya existe la costumbre de subir un archivo por plan a Supabase Storage (`link_video` +
  bucket `planes-videos`, ver `sql/planes-videos-bucket.sql`) — se replica igual para fotos,
  es más liviano y no hay límite de 16 MB por archivo que vigilar.
- Una foto de la tarjeta (domo, atardecer, jacuzzi) vende igual de bien que un video para este
  formato — el carrusel de Movistar en la captura usa foto, no video.
- El video sigue disponible como hoy: cuando el cliente ya eligió un plan y pide "más
  información", el bot le manda el video nativo (`sendVideoMessage`) — el carrusel es la
  vitrina inicial, el video es el detalle de cierre.

Si más adelante quieren un carrusel 100% en video, es el mismo procedimiento cambiando
`format: "IMAGE"` por `format: "VIDEO"` en todos los pasos de abajo — pero cada video pesa
hasta 16 MB y hay que grabar uno corto y vertical por plan, así que es más trabajo de
producción.

## 3. Dato que falta hoy: la foto de cada plan

La tabla `planes` hoy tiene `link_video` pero no una columna de imagen (ver
`src/core/db/catalogoRepo.ts`, interfaz `Plan`). Antes de crear la plantilla hace falta ese
dato. Propuesta — mismo patrón que ya usaron para los videos:

```sql
-- sql/planes-imagen-url.sql (propuesta, mismo patrón que planes-link-video.sql)
alter table planes add column if not exists imagen_url text;

comment on column planes.imagen_url is
  'URL pública de la foto de portada de este plan, para el carrusel de WhatsApp y otros usos. '
  'NULL = sin foto cargada.';
```

```sql
-- sql/planes-imagenes-bucket.sql (propuesta, mismo patrón que planes-videos-bucket.sql)
insert into storage.buckets (id, name, public)
values ('planes-imagenes', 'planes-imagenes', true)
on conflict (id) do update set public = true;

drop policy if exists "planes-imagenes: lectura pública" on storage.objects;
create policy "planes-imagenes: lectura pública"
  on storage.objects for select
  using (bucket_id = 'planes-imagenes');
```

Con eso, el equipo sube la foto desde Supabase Storage (o desde el panel admin del bot, igual
que hoy pegan el link del video) y guarda la URL pública en `imagen_url`. Requisito de
WhatsApp: la imagen tiene que ser accesible por internet sin login (público), formato JPG/PNG,
relación de aspecto horizontal recomendada (las tarjetas se recortan a formato ancho).

*(Estos dos SQL son una propuesta para que el equipo los revise y corra cuando esté listo — no
se aplicaron todavía a la base de datos.)*

## 4. Paso a paso para crear la plantilla

### Opción A — Desde el dashboard de YCloud (más fácil para la primera vez)
1. Entrar a YCloud → **Marketing Templates** → **Create Template**.
2. Tipo de plantilla: **Media card carousel template**.
3. Nombre: algo estable en snake_case, ej. `planes_lajulita_carousel_v1` (si luego cambian
   fotos/textos de fondo, se crea `_v2`, no se edita la aprobada).
4. Idioma: `es` o `es_CO`.
5. Categoría: `Marketing`.
6. Texto del cuerpo principal (el que va arriba del carrusel, no dentro de cada tarjeta), ej.:
   > "🏕️ Estos son nuestros planes disponibles en La Julita Glamping. ¡Desliza para ver todos!"
7. Agregar tarjetas (mínimo 2, hasta 10) — subir una foto de ejemplo por tarjeta, escribir el
   texto corto (precio + 1 línea de gancho) y los botones. Ver la plantilla lista en el punto 5
   para el texto exacto sugerido por plan.
8. Enviar a revisión.

### Opción B — Por API (para dejarlo scriptado / repetible)

`POST https://api.ycloud.com/v2/whatsapp/templates`
Header: `X-API-Key: {YCLOUD_API_KEY}` (la misma variable que ya usa `client.ts`).

Ejemplo ya armado con 3 planes reales de La Julita (Confort, Paraíso, Familiar 3 personas —
tomados de `pruebas/datos-reales.ts`), formato imagen, un botón de link por tarjeta hacia el
catálogo/WhatsApp de reservas:

```json
{
  "wabaId": "{{TU_WABA_ID}}",
  "name": "planes_lajulita_carousel_v1",
  "language": "es",
  "category": "MARKETING",
  "components": [
    {
      "type": "BODY",
      "text": "🏕️ Estos son nuestros planes disponibles en La Julita Glamping. ¡Desliza para ver todos!"
    },
    {
      "type": "CAROUSEL",
      "cards": [
        {
          "components": [
            { "type": "HEADER", "format": "IMAGE",
              "example": { "header_url": ["https://TU-PROYECTO.supabase.co/storage/v1/object/public/planes-imagenes/confort.jpg"] } },
            { "type": "BODY", "text": "Plan Confort · 1 noche, 2 personas\n💰 Desde $959.000" },
            { "type": "BUTTONS", "buttons": [
              { "type": "QUICK_REPLY", "text": "Quiero este plan" },
              { "type": "URL", "text": "Ver más fotos", "url": "https://lajulitaglamping.com/planes/confort" }
            ]}
          ]
        },
        {
          "components": [
            { "type": "HEADER", "format": "IMAGE",
              "example": { "header_url": ["https://TU-PROYECTO.supabase.co/storage/v1/object/public/planes-imagenes/paraiso.jpg"] } },
            { "type": "BODY", "text": "Plan Paraíso · 1 noche, 2 personas\n💰 Desde $1.490.000" },
            { "type": "BUTTONS", "buttons": [
              { "type": "QUICK_REPLY", "text": "Quiero este plan" },
              { "type": "URL", "text": "Ver más fotos", "url": "https://lajulitaglamping.com/planes/paraiso" }
            ]}
          ]
        },
        {
          "components": [
            { "type": "HEADER", "format": "IMAGE",
              "example": { "header_url": ["https://TU-PROYECTO.supabase.co/storage/v1/object/public/planes-imagenes/familiar-3.jpg"] } },
            { "type": "BODY", "text": "Plan Familiar 3 personas\n💰 Desde $760.000" },
            { "type": "BUTTONS", "buttons": [
              { "type": "QUICK_REPLY", "text": "Quiero este plan" },
              { "type": "URL", "text": "Ver más fotos", "url": "https://lajulitaglamping.com/planes/familiar-3" }
            ]}
          ]
        }
      ]
    }
  ]
}
```

Notas sobre este JSON:
- `header_url` en `example` es solo la foto de MUESTRA que Meta usa para revisar la plantilla —
  al enviarla de verdad, cada envío puede traer una URL distinta (por eso sirve para cualquier
  plan futuro sin tener que crear una plantilla por plan).
- Si no tienen todavía `lajulitaglamping.com/planes/...`, el botón `URL` puede apuntar al mismo
  sitio o catálogo que ya usen, o cambiarse por un segundo `QUICK_REPLY` (ej. "Ver precios de
  fin de semana") si prefieren mantener todo dentro de WhatsApp sin salir a un navegador.
- `wabaId` se obtiene desde el dashboard de YCloud (Settings → WhatsApp Business Account).

## 5. Cómo se envía una vez aprobada

`POST https://api.ycloud.com/v2/whatsapp/messages` — mismo endpoint que ya usa
`sendTextMessage`/`sendImageMessage` en `client.ts`.

```json
{
  "from": "{{YCLOUD_FROM_PHONE_NUMBER}}",
  "to": "+573001234567",
  "type": "template",
  "template": {
    "name": "planes_lajulita_carousel_v1",
    "language": { "code": "es", "policy": "deterministic" },
    "components": [
      {
        "type": "carousel",
        "cards": [
          {
            "card_index": 0,
            "components": [
              { "type": "header", "parameters": [
                { "type": "image", "image": { "link": "https://TU-PROYECTO.supabase.co/storage/v1/object/public/planes-imagenes/confort.jpg" } }
              ]},
              { "type": "button", "sub_type": "url", "index": 1,
                "parameters": [{ "type": "text", "text": "planes/confort" }] }
            ]
          },
          {
            "card_index": 1,
            "components": [
              { "type": "header", "parameters": [
                { "type": "image", "image": { "link": "https://TU-PROYECTO.supabase.co/storage/v1/object/public/planes-imagenes/paraiso.jpg" } }
              ]},
              { "type": "button", "sub_type": "url", "index": 1,
                "parameters": [{ "type": "text", "text": "planes/paraiso" }] }
            ]
          },
          {
            "card_index": 2,
            "components": [
              { "type": "header", "parameters": [
                { "type": "image", "image": { "link": "https://TU-PROYECTO.supabase.co/storage/v1/object/public/planes-imagenes/familiar-3.jpg" } }
              ]},
              { "type": "button", "sub_type": "url", "index": 1,
                "parameters": [{ "type": "text", "text": "planes/familiar-3" }] }
            ]
          }
        ]
      }
    ]
  }
}
```

Como el texto de cada tarjeta (`BODY`) se dejó fijo en la plantilla (no se usó `{{1}}`), en el
envío no hace falta mandar parámetros de `body` por tarjeta — solo la imagen real y, si el
botón de link usa una variable, el pedazo de URL de ese plan. Si en vez de texto fijo prefieren
que el precio viaje dinámico (para no re-aprobar la plantilla cada vez que suba una tarifa),
la única diferencia es escribir el `BODY` de cada tarjeta con `{{1}}` (ej. `"💰 Desde {{1}}"`)
y mandar ese precio como parámetro de tipo `text` en cada envío — recomendado si los precios
cambian seguido, que es justo el caso de La Julita (`precio_entre_semana` /
`precio_fin_de_semana` ya varían por temporada).

### Función lista para pegar en `client.ts`

Sigue el mismo estilo que `sendImageMessage`/`sendVideoMessage` (dry-run, retry, mismo
endpoint):

```ts
export interface TarjetaCarousel {
  imagenUrl: string;
  /** Solo si la plantilla usa {{1}} en el BODY de la tarjeta (ver nota arriba). */
  precioTexto?: string;
  /** Solo si el botón URL de la plantilla trae variable. */
  urlVariable?: string;
}

export async function sendCarouselTemplate(
  target: string,
  templateName: string,
  tarjetas: TarjetaCarousel[]
): Promise<{ id?: string }> {
  if (YCLOUD_DRY_RUN) {
    console.log(`[ycloud dry-run] carousel "${templateName}" a ${target}: ${tarjetas.length} tarjetas`);
    return { id: `dry-run-carousel-${Date.now()}` };
  }
  const cards = tarjetas.map((t, i) => {
    const components: Record<string, unknown>[] = [
      { type: "header", parameters: [{ type: "image", image: { link: t.imagenUrl } }] },
    ];
    if (t.precioTexto) {
      components.push({ type: "body", parameters: [{ type: "text", text: t.precioTexto }] });
    }
    if (t.urlVariable) {
      components.push({
        type: "button", sub_type: "url", index: 1,
        parameters: [{ type: "text", text: t.urlVariable }],
      });
    }
    return { card_index: i, components };
  });

  const body = {
    from: YCLOUD_FROM_PHONE_NUMBER,
    to: target,
    type: "template",
    template: {
      name: templateName,
      language: { code: "es", policy: "deterministic" },
      components: [{ type: "carousel", cards }],
    },
  };
  const res = await withRetry(() => getClient().post("/v2/whatsapp/messages", body), "sendCarouselTemplate");
  return res.data ?? {};
}
```

*(Este bloque es una propuesta para pegar en `src/channels/whatsapp-ycloud/client.ts` — no se
modificó el archivo real todavía. Avísame y lo dejo integrado, con su tarea `prueba:carousel`
igual que las demás en `pruebas/`.)*

## 6. Dónde engancharlo en el flujo del bot

Hoy, cuando el cliente pide ver los planes, `consultarPlanesTool` (en
`src/agentes/ventas/herramientas/planes.ts`) responde con texto (lista o detalle). El carrusel
encaja como una alternativa quer se dispara cuando el cliente pide **ver el menú completo**
("qué planes tienen", "muéstrame las opciones"), mandando primero el carrusel (la vitrina
visual) y dejando el texto detallado para cuando pregunte por un plan puntual — igual que hace
Movistar (carrusel primero, detalle después si el cliente pregunta más).

Importante: el carrusel es plantilla `MARKETING`, así que aplica la política de WhatsApp de
mensajes de marketing (límites de envíos por plantilla marcados por la calidad de la cuenta, y
en algunos países exige opt-in explícito del cliente). Mandarlo como **respuesta** dentro de
una conversación que el cliente ya inició (te escribió primero) es el uso normal y esperado;
el problema de opt-in aplica sobre todo si algún día quieren usarlo para **campañas salientes**
(broadcast a gente que no ha escrito). Vale la pena revisar los límites de mensajes de
marketing vigentes en el Business Manager de Meta antes de activarlo en producción.

## 7. Checklist para dejarlo funcionando

- [ ] Decidir: ¿foto o video en el carrusel? (recomendado: foto, ver sección 2)
- [ ] Correr las migraciones de `imagen_url` + bucket `planes-imagenes` (sección 3) y subir al
      menos 2 fotos horizontales (una por plan que se quiera mostrar primero)
- [ ] Crear la plantilla en YCloud (sección 4, Opción A o B) con el número de tarjetas que
      quieran dejar fijo (sugerido: 3 a 5, los planes más vendidos — no hace falta meter los 13)
- [ ] Esperar aprobación de Meta
- [ ] Pegar `sendCarouselTemplate` en `client.ts` (sección 5) y conectarla desde
      `planes.ts` / el orquestador
- [ ] Probar con `YCLOUD_DRY_RUN=true` primero, luego con un número real

## Fuentes

- [Media card carousel templates — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/media-card-carousel-templates)
- [Product card carousel templates — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/product-card-carousel-template-messages)
- [Carousel Template — YCloud Help Center](https://helpdocs.ycloud.com/help-center/whatsapp-basics/message-templates/carousel-template)
- [WhatsApp Template Creation Examples — YCloud API Reference](https://docs.ycloud.com/reference/whatsapp-template-creation-examples)
- [WhatsApp Messaging Examples — YCloud API Reference](https://docs.ycloud.com/reference/whatsapp-messaging-examples)
