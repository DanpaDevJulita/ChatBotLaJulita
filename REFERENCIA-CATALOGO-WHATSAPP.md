# REFERENCIA: Catálogo de WhatsApp (la alternativa GRATIS al carrusel)

> [2026-09-15] Pedido de Daniel: mostrar los planes "diferente y bonito", pero sin pagar el
> costo de mensaje de Marketing que sí tiene el carrusel (ver `REFERENCIA-CAROUSEL-WHATSAPP.md`
> y `REFERENCIA-MODULO-PROMOCIONES.md`, donde quedó confirmado que el carrusel SIEMPRE es
> Marketing, sin excepción — Meta lo restringe así, no depende de cómo redactes el contenido).

Esto es distinto: el **mensaje de catálogo** (`interactive.type: "product_list"`) es un mensaje
normal, no una plantilla — **gratis** dentro de una conversación abierta, igual que el texto o
una imagen suelta que ya manda el bot hoy. El cliente ve los planes con foto, en una tarjeta
donde puede deslizar y tocar cada uno para ver el detalle — no es idéntico al carrusel
horizontal de Movistar, pero es la opción más parecida que existe sin costo por mensaje.

**La condición**: cada plan tiene que existir como "producto" en un catálogo de Meta conectado
a tu WhatsApp Business Account. Eso es 100% manual (Meta Commerce Manager) — el código no
puede crear catálogos ni cargar productos por su cuenta.

## Ya quedó en el código

| Archivo | Qué hace |
|---|---|
| `sql/planes-retailer-id.sql` | Agrega `planes.retailer_id` — el SKU de ese plan en el catálogo de Meta. |
| `.env.example` → `YCLOUD_CATALOG_ID` | El id del catálogo conectado a tu WABA. |
| `src/channels/whatsapp-ycloud/client.ts` | `sendMultiProductMessage` — arma y manda el mensaje de catálogo a la API de YCloud. |
| `src/channels/types.ts`, `whatsapp-ycloud/adapter.ts`, `console/adapter.ts` | El "contrato" entre canales (`OutboundMessage.catalogo`) ya sabe mandar/loguear este tipo de mensaje. |
| `src/core/tools/types.ts`, `src/core/pipeline/enviar.ts`, `runTurn.ts` | Mismo mecanismo que ya usan para el video nativo (`ToolResult.videoUrl`): una herramienta puede pedir "manda también el catálogo", y `runTurn.ts` lo entrega aparte del texto, al final del turno. |
| `src/agentes/ventas/herramientas/planes.ts` — `seccionesCatalogoDe()` | Cuando el bot arma el menú de 2-3 planes (la "escalera" de experiencias), si alguno de esos planes YA tiene `retailer_id` cargado, se manda TAMBIÉN el catálogo con esos — nunca inventa un SKU para el que no lo tenga. |
| `src/web/admin/routes.ts` + panel (`dashboard.html`/`admin.js`) | La pestaña "Planes" ahora tiene un campo "SKU en el catálogo de WhatsApp" por plan. |
| `pruebas/e2e-catalogo-whatsapp.ts` (`npm run prueba:catalogo-whatsapp`) | Confirma que solo arma el catálogo con los planes que sí tienen SKU, y que nunca lo completa con datos inventados. |

**Hoy mismo no manda ningún catálogo real todavía** — falta la parte manual de abajo. Mientras
`YCLOUD_CATALOG_ID` esté vacío o ningún plan tenga `retailer_id`, el bot sigue contestando
exactamente como hoy (solo texto), sin romper nada.

## Lo que falta — pasos manuales en Meta

### 1. Crear (o reutilizar) un catálogo de productos
En [Meta Commerce Manager](https://business.facebook.com/commerce/) → Catálogos → Agregar
catálogo → "Otro" (o "E-commerce" si prefieres). Si La Julita ya tiene un catálogo de Facebook/
Instagram Shopping, se puede reutilizar el mismo.

### 2. Cargar cada plan como "producto"
Puede ser a mano desde Commerce Manager o subiendo un archivo (CSV/feed). Por cada plan:
- **Foto**: una imagen horizontal del domo/plan.
- **Nombre**: el mismo nombre del plan (o uno más corto y comercial).
- **Precio**: el de entre semana (o el que quieras que aparezca por defecto — el precio real
  que cotiza el bot sigue siendo el de la base de datos, esto es solo lo que se VE en la
  tarjeta).
- **SKU / ID de contenido (`retailer_id`)**: elige uno simple y estable, ej. `plan-confort`,
  `plan-paraiso`, `plan-familiar-3` — este es el dato que después va a la columna
  `planes.retailer_id`.

### 3. Conectar el catálogo a tu WhatsApp Business Account
Meta Business Suite → WhatsApp Manager → tu número → Catálogo → conectar el catálogo del
paso 1. Ahí mismo Meta te muestra el **Catalog ID** (un número).

### 4. Configurar el bot
- Pegar ese Catalog ID en `YCLOUD_CATALOG_ID` (`.env`).
- Correr `sql/planes-retailer-id.sql`.
- Cargar el `retailer_id` de cada plan desde el panel admin (pestaña Planes → campo "SKU en el
  catálogo de WhatsApp"), con el mismo SKU que le pusiste en Commerce Manager.

Con eso, la próxima vez que el bot le arme el menú de planes a un cliente, si esos planes ya
tienen SKU cargado, le va a llegar el texto de siempre **y**, aparte, la tarjeta de catálogo
con foto para deslizar — gratis, porque no es una plantilla.

## Diferencia con el carrusel de promociones (para no mezclarlos)

| | Catálogo (esto) | Carrusel (`REFERENCIA-MODULO-PROMOCIONES.md`) |
|---|---|---|
| Costo | Gratis (mensaje normal) | Cobra por mensaje (plantilla Marketing) |
| Cuándo se puede mandar | Solo dentro de una conversación abierta (el cliente ya escribió) | También a gente que no ha escrito (rompe la ventana de 24h) |
| Requiere aprobación de Meta | No | Sí, cada plantilla |
| Requiere catálogo de productos | Sí | No |
| Para qué sirve | Mostrar los planes normales, todos los días, dentro del chat | Campañas puntuales de ofertas/descuentos, disparadas a mano |

Son dos herramientas distintas para dos momentos distintos — no hace falta elegir una sola.
