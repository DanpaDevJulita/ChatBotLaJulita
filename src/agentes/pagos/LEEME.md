# Bot de Pagos — sin construir todavía

Esta carpeta está reservada para el bot de Pagos. Hoy el tema `pagos` lo atiende el bot de
**ventas** (ver `src/agentes/ventas/agente.ts`, campo `atiende`).

El diseño está en `prompt-de-diseno.md`, pero **quedó desactualizado en un punto importante**:
asume una herramienta `enviarDatosPago` que había que construir desde cero. Después descubrimos
que la API de LobbyPMS ya ofrece enlaces de pago (`POST /api/v1/payment/link`), que además
permiten **consultar si el cliente ya pagó** (`GET`) sin depender de que mande el comprobante.
Ver `REFERENCIA-API-LOBBYPMS.md` en la raíz del proyecto, sección 10.

Para construirlo: seguí los pasos de `../LEEME.md` y sacá `"pagos"` del `atiende` de ventas.
