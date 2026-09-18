import type { ToolDefinition } from "../../../core/tools/types.js";
import { planesRepo } from "../../../core/db/catalogoRepo.js";
import type { Plan } from "../../../core/db/catalogoRepo.js";
import { politica } from "../../../core/db/politicasRepo.js";
import { formatMoney, tipoDePlan } from "./planes.js";

/**
 * [2026-09-17] `presentar_glamping` — la respuesta a "solo quiero precios".
 *
 * De dónde sale: probando con un vendedor, un cliente escribió "Solo quiero precios" sin decir
 * fecha ni cuántas personas, y el bot le contestó con el menú de las tres experiencias y tres
 * cifras. El vendedor pidió corregirlo — un precio suelto, sin fecha ni número de personas, no
 * significa nada y encima ancla al cliente en una cifra que después no le va a cuadrar. Lo que
 * hay que hacer es presentarle el glamping, dejar claro que el valor varía según la fecha
 * exacta, la cantidad de personas y el tipo de plan, y pedirle esos dos datos.
 *
 * El texto lo escribió Daniel y vive en la tabla `politicas` con la clave `presentacion_general`
 * (ver sql/presentacion-general.sql) para que el equipo lo pueda cambiar desde el panel sin
 * tocar código. Acá solo se resuelven los `$$$$`.
 *
 * [2026-09-17, segunda vuelta — ticket #5 del panel] La primera versión mandaba una presentación
 * larga que cerraba con dos "desde". Daniel la probó en vivo y pidió sacarla: el "desde" de entre
 * semana le salió en $ 3.000 (el precio real del plan más barato cargado en la base) y un número
 * así, suelto, no dice nada bueno ni se parece a lo que el cliente va a terminar pagando. Ahora
 * el texto cargado es una sola frase, SIN ninguna cifra.
 *
 * Por eso esta herramienta ya no publica ningún precio en `result`: si devolviera los "desde"
 * como dato crudo, quedarían habilitados para la verificación de runTurn.ts y el modelo podría
 * escribirlos en el mensaje siguiente — justo lo que se pidió dejar de mandar (ver `montosEn` en
 * src/core/pipeline/runTurn.ts).
 *
 * El soporte de `$$$$` se deja igual, porque el texto se edita desde el panel: el día que alguien
 * vuelva a poner una cifra, tiene que salir de la base y no escrita a mano. Un precio a mano es
 * el bug del 2026-09-11 otra vez — una tarifa que queda vieja en cuanto el equipo cambia la
 * columna, prometiéndole al cliente un valor que ya no existe.
 */

/**
 * El precio de la noche MÁS ECONÓMICA que haya cargada, para cada tarifa. Lo definió Daniel el
 * 2026-09-17: "el desde de entre semana y fin de semana se toma de la noche más económica que
 * tengamos".
 *
 * Los pasadías quedan afuera a propósito: no son una noche, así que su tarifa no puede ser el
 * "desde" de un plan de alojamiento (y hay pasadías más baratos que cualquier noche, con lo cual
 * sin este filtro el mensaje mostraría un precio que el cliente no puede tomar para dormir).
 *
 * El 0 también queda afuera: en esta base "no aplica" está cargado como 0 (por ejemplo, un plan
 * que no se vende entre semana), y mostrarlo sería decirle al cliente que cuesta cero pesos.
 */
function nocheMasEconomica(planes: Plan[], tarifa: "entre_semana" | "fin_de_semana"): number | null {
  const valores = planes
    .filter((p) => tipoDePlan(p) !== "pasadia")
    .map((p) => (tarifa === "entre_semana" ? p.precio_entre_semana : p.precio_fin_de_semana))
    .filter((v): v is number => Boolean(v));
  return valores.length > 0 ? Math.min(...valores) : null;
}

/**
 * Reemplaza los `$$$$` del texto, eligiendo la tarifa según lo que diga esa misma línea — mismo
 * criterio que `resolverPreciosEnDescripcion` en planes.ts, para que el equipo no tenga que
 * aprender dos convenciones distintas.
 *
 * Si una línea trae `$$$$` y no se puede resolver, la línea se quita entera en vez de mandarle al
 * cliente un `$$$$` crudo o un precio adivinado que no corresponde a lo que dice la frase.
 */
function resolverTokens(texto: string, planes: Plan[]): string {
  return texto
    .split("\n")
    .map((linea) => {
      if (!linea.includes("$$$$")) return linea;
      const s = linea.toLowerCase();
      const tarifa = /fin de semana|s[aá]bado|domingo|finde/.test(s)
        ? "fin_de_semana"
        : /entre semana|lunes a viernes|lunes a jueves|entresemana/.test(s)
          ? "entre_semana"
          : null;
      const precio = tarifa ? nocheMasEconomica(planes, tarifa) : null;
      if (precio == null) {
        console.warn(
          "[presentacion] la presentación trae un $$$$ que no se pudo resolver a ningún precio " +
            `cargado (línea: "${linea.trim()}") — se quita la línea.`
        );
        return null;
      }
      return linea.replace(/\$\$\$\$/g, formatMoney(precio));
    })
    .filter((l): l is string => l != null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Lo que se dice cuando la presentación no está cargada en la base. NO hay un texto de respaldo
 * escrito acá a propósito — misma regla que `politicasRepo`: un texto duplicado en el código es
 * el que termina quedando viejo. Igual el mensaje cumple lo que pidió el vendedor (aclarar de qué
 * depende el precio y pedir los datos), solo que sin la presentación bonita.
 */
const SIN_PRESENTACION =
  "¡Con mucho gusto! 💚 El valor cambia según la fecha exacta, cuántas personas vienen y el plan " +
  "que elijan, así que no tengo un precio único que darte.\n\n" +
  "📲 Cuéntame la fecha y cuántas son, y te armo la opción ideal ✨";

export const presentarGlampingTool: ToolDefinition = {
  name: "presentar_glamping",
  description:
    "La ÚNICA respuesta válida cuando el cliente pide precios y TODAVÍA no dijo ni la fecha ni " +
    "cuántas personas son ('precios', 'info', 'cuánto cuesta', 'solo quiero precios', 'pásame la " +
    "lista de precios', 'cuánto vale una noche'). Le explica que el valor varía según la fecha " +
    "exacta, cuántos vienen y el plan. En ese caso NO llames consultar_planes: su menú de tres " +
    "experiencias le tiraría cifras sueltas que no corresponden a su fecha ni a su grupo, y el " +
    "equipo de ventas pidió expresamente dejar de mandarlas. Apenas te diga la fecha o cuántas " +
    "personas son, ahí sí va consultar_planes, que cotiza de verdad.",
  // Texto literal: trae cifras y es la presentación oficial del negocio, no material para
  // redactar. Además, si el modelo lo reescribiera, la cifra tendría que volver a pasar por la
  // verificación del pipeline y el mensaje se podría caer entero.
  permitirRedaccion: false,
  parameters: { type: "object", properties: {}, required: [] },
  handler: async () => {
    const [texto, planes] = await Promise.all([politica("presentacion_general"), planesRepo.list(true)]);

    if (!texto) {
      console.warn("[presentacion] la clave `presentacion_general` no está cargada en `politicas` — uso el mensaje corto.");
      return { result: { presentacion_cargada: false }, reply_to_user: SIN_PRESENTACION };
    }

    const resuelto = resolverTokens(texto, planes);
    return {
      // Sin cifras a propósito (ver el comentario de arriba): los "desde" NO se publican como
      // dato crudo, porque eso los habilitaría para que el modelo los escriba en el mensaje
      // siguiente. Si el texto cargado trae un `$$$$`, su precio ya viaja resuelto dentro de
      // `reply_to_user` y runTurn.ts lo habilita desde ahí.
      result: {
        presentacion_cargada: true,
        nota:
          "Ya se le explicó de qué depende el valor. NO le des ningún precio hasta que diga la " +
          "fecha y cuántas personas son: con esos dos datos, cotiza con consultar_planes.",
      },
      reply_to_user: resuelto,
    };
  },
};
