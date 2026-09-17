import type { ChannelAdapter, OutboundMessage } from "../../channels/types.js";

/**
 * [2026-09-08] `adapter.send` es la última posta antes de que el mensaje llegue de verdad al
 * cliente (para WhatsApp, una llamada HTTP a la API de YCloud) — si falla (red, YCloud caído,
 * número inválido) NO queremos que la excepción se lleve por delante todo el turno sin dejar
 * rastro claro. Con su propio log queda evidente en la consola cuándo el bot generó una
 * respuesta pero no logró entregarla, que es muy distinto de un fallo del modelo.
 *
 * Vive en su propio archivo porque lo usan tanto el turno normal (runTurn.ts) como los
 * recontactos automáticos (recontacto.ts).
 */
export async function enviarSeguro(
  adapter: ChannelAdapter,
  to: string,
  text: string,
  key: string
): Promise<boolean> {
  try {
    await adapter.send({ to, text });
    return true;
  } catch (err) {
    console.error(
      `[enviar] Falló el envío al cliente por "${adapter.name}" — ${key}: el mensaje quedó generado pero NO entregado.`,
      err
    );
    return false;
  }
}

/**
 * [2026-09-16] Mismo contrato que `enviarSeguro`, pero para un VIDEO NATIVO (ver
 * ToolResult.videoUrl en core/tools/types.ts).
 *
 * [2026-09-17] `caption` es OPCIONAL y, cuando se manda, es lo que de verdad soluciona el orden
 * video-antes-que-texto: al pasarlo, `videoUrl` y el texto viajan en UN SOLO mensaje de
 * WhatsApp (el video con el texto como pie de foto), no dos mensajes separados. Se probó en
 * real: aunque el código pida el video primero y el texto después, son dos llamadas HTTP
 * independientes — WhatsApp tarda más en procesar y entregar un video (lo descarga, le saca
 * miniatura) que un texto plano, que llega casi instantáneo, así que el cliente los podía
 * terminar viendo en el orden contrario al que se mandaron. Con un solo mensaje (video +
 * caption) no hay dos entregas que puedan desordenarse: es una sola unidad.
 *
 * [2026-09-17] Ahora el video SIEMPRE se manda con caption: `runTurn.ts` parte el texto con
 * `partirParaCaption` (abajo) cuando no cabe entero, y lo que sobra sale en un segundo mensaje.
 * Antes, en ese caso, el video iba solo y TODO el texto aparte — que es justo lo que Daniel no
 * quería ver ("separaste el mensaje del video").
 *
 * Si falla (el archivo no es un mp4 válido, la URL no es pública, pesa más de lo que permite
 * WhatsApp...) se loguea y el turno sigue: `runTurn.ts` manda el texto completo como mensaje de
 * texto aparte, para que el cliente no se quede sin ninguna respuesta.
 */
/**
 * [2026-09-17] Parte un texto en dos para que la PRIMERA parte quepa como pie de foto de un
 * video (ver LIMITE_CAPTION_WHATSAPP en channels/types.ts) y el resto siga en un segundo
 * mensaje. Devuelve `["todo el texto", ""]` cuando ya cabía entero.
 *
 * El corte se hace en el último SALTO DE LÍNEA antes del límite: así nunca parte una palabra ni
 * un ítem de la lista de un plan por la mitad. A propósito NO se corta en el último renglón en
 * blanco (que sería más "limpio"): en las descripciones reales los renglones en blanco están
 * todos al principio y al final, así que cortar ahí dejaría el pie de foto en 100 caracteres
 * usando solo una décima parte de lo que WhatsApp permite, y mandaría casi todo el plan al
 * segundo mensaje. Si por alguna razón el texto no trae ningún salto de línea utilizable, se
 * corta seco en el límite: peor es que WhatsApp rechace el mensaje entero.
 */
export function partirParaCaption(texto: string, limite: number): [string, string] {
  if (texto.length <= limite) return [texto, ""];
  const corte = texto.lastIndexOf("\n", limite);
  // Un corte demasiado temprano (menos de la mitad del límite) desperdicia el pie de foto.
  const donde = corte > limite / 2 ? corte : limite;
  return [texto.slice(0, donde).trimEnd(), texto.slice(donde).trim()];
}

export async function enviarVideoSeguro(
  adapter: ChannelAdapter,
  to: string,
  videoUrl: string,
  key: string,
  caption?: string
): Promise<boolean> {
  try {
    await adapter.send({ to, videoUrl, text: caption });
    return true;
  } catch (err) {
    console.error(
      `[enviar] Falló el envío del VIDEO al cliente por "${adapter.name}" — ${key} (${videoUrl}): ` +
        (caption ? "el texto iba de pie de foto en este mismo mensaje, así que tampoco llegó." : "el texto ya se mandó, pero el video no llegó."),
      err
    );
    return false;
  }
}



/**
 * [2026-09-16] Mismo contrato que `enviarVideoSeguro`, pero para una IMAGEN NATIVA (jpg, png, etc.).
 * Funciona igual que el video: se manda como IMAGEN NATIVA de WhatsApp con optional caption.
 */
export async function enviarImageSeguro(
  adapter: ChannelAdapter,
  to: string,
  imageUrl: string,
  key: string,
  caption?: string
): Promise<boolean> {
  try {
    await adapter.send({ to, imageUrl, text: caption });
    return true;
  } catch (err) {
    console.error(
      `[enviar] Falló el envío de la IMAGEN al cliente por "${adapter.name}" — ${key} (${imageUrl}): ` +
        (caption ? "el texto iba de pie de foto en este mismo mensaje, así que tampoco llegó." : "el texto ya se mandó, pero la imagen no llegó."),
      err
    );
    return false;
  }
}

/**
 * [2026-09-15] Mismo contrato que enviarSeguro/enviarVideoSeguro, pero para el mensaje de
 * CATÁLOGO (ver ToolResult.catalogoWhatsApp) — la alternativa gratis al carrusel de pago. Se
 * manda COMO SU PROPIO mensaje, aparte del texto normal (a diferencia del video, acá no hace
 * falta combinarlos en uno solo: no hay archivo que WhatsApp tenga que descargar, así que no
 * hay riesgo real de que lleguen desordenados).
 */
export async function enviarCatalogoSeguro(
  adapter: ChannelAdapter,
  to: string,
  catalogo: NonNullable<OutboundMessage["catalogo"]>,
  key: string
): Promise<boolean> {
  try {
    await adapter.send({ to, catalogo });
    return true;
  } catch (err) {
    console.error(
      `[enviar] Falló el envío del CATÁLOGO al cliente por "${adapter.name}" — ${key}: el texto sí se entregó, el catálogo no.`,
      err
    );
    return false;
  }
}
