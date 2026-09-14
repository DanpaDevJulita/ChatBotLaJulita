import type { ToolDefinition, ToolContext } from "../../../core/tools/types.js";
import { planesRepo, adicionalesRepo, getConfiguracion, getDomosYClases } from "../../../core/db/catalogoRepo.js";
import { consultarDisponibilidad, type DisponibilidadCategoria } from "../../../core/integrations/lobbypms.js";
import { contarBloqueosActivos } from "../../../core/db/bloqueosRepo.js";
import type { Plan } from "../../../core/db/catalogoRepo.js";

function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

/** "1 persona" / "4 personas" — el plural mal puesto se nota y queda descuidado. */
function textoPersonas(cantidad: number): string {
  return `${cantidad} ${cantidad === 1 ? "persona" : "personas"}`;
}

/** Los textos vienen del panel con saltos de línea de Windows; WhatsApp se lleva mejor con \n. */
function limpiar(texto: string | null | undefined): string {
  return (texto ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * [2026-09-11] Varias descripciones de planes (cargadas por el equipo antes de que existieran
 * las columnas de precio separadas) traen el precio escrito A MANO adentro del texto libre
 * ("Entre semana (lunes a viernes): $590.000..."). El problema: si después el equipo cambia el
 * precio de verdad (en `precio_entre_semana`/`precio_fin_de_semana`/`precio_fin_de_semana_puente`
 * — la fuente real, la que arma `lineaPrecio`/`preciosDe`), ese texto suelto de la descripción
 * queda desactualizado, y el cliente termina viendo DOS precios distintos para el mismo plan en
 * el mismo mensaje: el correcto (de la columna) y el viejo (pegado en la descripción). Así se
 * descubrió: el PLAN FAMILIAR 3 PERSONAS (id 30) tenía el precio ya editado en la columna, pero
 * la descripción seguía con el valor anterior, y el mensaje final citaba ESE. Una revisión
 * encontró el mismo problema en otros 4 planes (ids 3, 28, 31, 32).
 *
 * [2026-09-11 → 2026-09-13] La primera versión de este arreglo borraba de raíz cualquier línea
 * que pareciera traer un precio ("$" seguido de números) — funcionaba (nunca más viajó un precio
 * viejo), pero se notaba: esa línea solía traer también el emoji y la palabra que la acompañaban
 * ("💰 Entre semana (lunes a viernes): $590.000"), así que el mensaje quedaba con un hueco feo,
 * poco agradable a la vista (lo notó Daniel en pruebas reales).
 *
 * Ahora, en vez de borrar la línea, se REEMPLAZA solo el precio: el equipo edita la descripción
 * en el panel y en el lugar exacto donde iba el número pone el texto literal `$$$$` (ej. "💰
 * Entre semana (lunes a viernes): $$$$"). Acá se busca ese token y se cambia por el precio de
 * verdad (columna), eligiendo CUÁL de los tres precios según lo que ya dice esa misma línea
 * ("entre semana", "fin de semana", "puente") — así una sola descripción puede traer los tres
 * tokens, uno por línea, cada uno resuelto con su propio precio. El emoji y el resto del texto de
 * la línea quedan intactos.
 *
 * Sigue existiendo, como red de seguridad, el borrado de líneas con un precio escrito A MANO
 * (planes que el equipo todavía no migró a `$$$$`) — para que nunca se cuele un precio viejo
 * mientras se termina de editar el resto de las plantillas.
 */
function precioPorPalabrasDeLaLinea(linea: string, p: Plan): number | null {
  const s = linea.toLowerCase();
  // [2026-09-14] "festivo" cuenta igual que "puente", y va PRIMERO. Se descubrió al revisar las
  // descripciones reales antes de migrarlas a `$$$$`: el PLAN UNA PERSONA (id 28) tiene la línea
  // "Fin de semana festivo (viernes, sábado o domingo) domo clásico chalet: $779.000" — el valor
  // es el de PUENTE, pero como la línea también dice "fin de semana", sin esto se le habría
  // puesto el precio de fin de semana normal ($679.000). Un precio equivocado, en el mensaje que
  // lee el cliente. Por eso el orden importa: lo más específico (puente/festivo) primero.
  if (/puente|festivo/.test(s)) return p.precio_fin_de_semana_puente || null;
  if (/fin de semana|s[aá]bado|domingo|finde/.test(s)) return p.precio_fin_de_semana || null;
  // "lunes a jueves" aparece en varias descripciones reales (no solo "lunes a viernes").
  if (/entre semana|lunes a viernes|lunes a jueves|entresemana/.test(s)) return p.precio_entre_semana || null;
  return null;
}

function resolverPreciosEnDescripcion(texto: string, p: Plan): string {
  return texto
    .split("\n")
    .map((linea) => {
      if (linea.includes("$$$$")) {
        // [2026-09-13] A propósito SIN caer a `precioReferencia` (el más barato de los tres):
        // mostrar un precio "adivinado" en una línea que no dice a cuál tarifa corresponde es
        // peor que no mostrar nada — el cliente vería un precio real pero pegado a la frase
        // equivocada, más engañoso que la línea vacía que reemplaza.
        const precio = precioPorPalabrasDeLaLinea(linea, p);
        if (precio == null) {
          console.warn(
            `[planes] plan "${p.nombre}" (id ${p.id}): la descripción trae un $$$$ que no se pudo ` +
              "resolver a ningún precio cargado — se quita la línea para no mostrarle nada raro al cliente."
          );
          return null;
        }
        return linea.replace(/\$\$\$\$/g, formatMoney(precio));
      }
      // Red de seguridad: precio viejo escrito a mano, todavía sin migrar a $$$$.
      if (/\$\s?\d/.test(linea)) return null;
      return linea;
    })
    .filter((linea): linea is string => linea != null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Precios de un plan, saltando los que no aplican. OJO: en la tabla `planes` un precio que
 * no aplica está cargado como 0 (por ejemplo, un pasadía de domingo no tiene tarifa de
 * entre semana) — antes eso se le mostraba al cliente como "$ 0", o sea el bot le decía que
 * costaba cero pesos. Por eso acá 0 y null se tratan igual: no se muestran.
 */
function preciosDe(p: Plan): string {
  const partes: string[] = [];
  if (p.precio_entre_semana) partes.push(`entre semana ${formatMoney(p.precio_entre_semana)}`);
  if (p.precio_fin_de_semana) partes.push(`fin de semana ${formatMoney(p.precio_fin_de_semana)}`);
  if (p.precio_fin_de_semana_puente) partes.push(`fin de semana con puente ${formatMoney(p.precio_fin_de_semana_puente)}`);
  return partes.length > 0 ? partes.join(", ") : "precio a confirmar con el equipo";
}

// ---- Clasificación de planes: para no mandarle los 20 planes de golpe al cliente --------

const PLANES_POR_TANDA = 3;

/** Orden en que queremos mostrar los tipos de alojamiento dentro de cada tanda. */
const CLASES_PREFERIDAS = ["chalet", "clasico", "deluxe"];

const NUMEROS_ESCRITOS: Record<string, number> = {
  una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
};

function sinTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export interface CatalogoDomos {
  claseDeDomo: Map<number, string>;
  capacidadDeDomo: Map<number, number>;
}

export async function cargarCatalogoDomos(): Promise<CatalogoDomos> {
  const { domos, clases } = await getDomosYClases();
  const nombreDeClase = new Map<number, string>();
  for (const c of clases) if (c.id != null) nombreDeClase.set(c.id, sinTildes(c.nombre ?? ""));
  const claseDeDomo = new Map<number, string>();
  const capacidadDeDomo = new Map<number, number>();
  for (const d of domos) {
    if (d.id == null) continue;
    const nombre = nombreDeClase.get(d.clase);
    if (nombre) claseDeDomo.set(d.id, nombre);
    if (d.capacidad_max) capacidadDeDomo.set(d.id, d.capacidad_max);
  }
  return { claseDeDomo, capacidadDeDomo };
}

/**
 * Tipos de alojamiento de un plan. Sale de `planes.domos_id` -> `domos.clase`; si ese arreglo
 * todavía no está cargado en la base, se deduce del nombre y la descripción, que sí lo dicen
 * ("DOMO CLASICO O CHALET", "La Julita Deluxe"...).
 */
export function clasesDePlan(p: Plan, cat: CatalogoDomos): string[] {
  const desdeDomos = [
    ...new Set(
      (p.domos_id ?? [])
        .map((id) => cat.claseDeDomo.get(id))
        .filter((c): c is string => Boolean(c))
    ),
  ];
  if (desdeDomos.length > 0) return desdeDomos;
  const texto = sinTildes(`${p.nombre ?? ""} ${p.descripcion ?? ""}`);
  return CLASES_PREFERIDAS.filter((c) => texto.includes(c));
}

export function claseParaAgrupar(p: Plan, cat: CatalogoDomos): string {
  const clases = clasesDePlan(p, cat);
  for (const preferida of CLASES_PREFERIDAS) if (clases.includes(preferida)) return preferida;
  return clases[0] ?? "otros";
}

/**
 * Para cuántas personas es EL PLAN. El orden importa y me costó un bug:
 *   1. el nombre del plan ("... PARA DOS PERSONAS"), que es lo que el equipo vende;
 *   2. como último recurso, la capacidad máxima de los domos del plan.
 *
 * [2026-09-09] Antes esto miraba primero una columna `planes.capacidad`. Esa columna NO
 * existe en la base (se quitó en el rediseño): cualquier lectura que la pida falla con
 * 42703. La capacidad real vive en el nombre del plan y en `domos.capacidad_max`.
 *
 * [2026-09-08] Antes los domos iban en el paso 2 y el bot decía "PLAN PARAISO (hasta 4
 * personas)" cuando ese plan es para dos: el domo que usa admite físicamente hasta 4 (sirve
 * también para familias), pero eso NO es la capacidad del plan. Con la capacidad del domo por
 * delante, el bot le ofrecía a una familia de 4 un plan de pareja.
 */
export function capacidadDePlan(p: Plan, cat: CatalogoDomos): number | null {
  const m = sinTildes(p.nombre ?? "").match(/(una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|\d+)\s+personas?/);
  if (m) {
    const delNombre = NUMEROS_ESCRITOS[m[1]] ?? (Number(m[1]) || null);
    if (delNombre) return delNombre;
  }
  const desdeDomos = (p.domos_id ?? []).map((id) => cat.capacidadDeDomo.get(id) ?? 0);
  const mayor = desdeDomos.length > 0 ? Math.max(...desdeDomos) : 0;
  return mayor > 0 ? mayor : null;
}

type TipoPlan = "una_noche" | "dos_noches" | "pasadia";

function tipoDePlan(p: Plan): TipoPlan {
  const t = sinTildes(p.nombre ?? "");
  if (t.includes("pasadia")) return "pasadia";
  if (t.includes("dos noches")) return "dos_noches";
  return "una_noche";
}

/**
 * Reordena alternando tipos de alojamiento, así CADA tanda de 3 sale variada (uno de chalet,
 * uno de clásico, uno de deluxe) en vez de tres planes parecidos entre sí.
 */
function alternandoPorClase(planes: Plan[], cat: CatalogoDomos): Plan[] {
  const baldes = new Map<string, Plan[]>();
  for (const p of planes) {
    const clase = claseParaAgrupar(p, cat);
    if (!baldes.has(clase)) baldes.set(clase, []);
    baldes.get(clase)!.push(p);
  }
  const orden = [...baldes.keys()].sort((a, b) => {
    const ia = CLASES_PREFERIDAS.indexOf(a);
    const ib = CLASES_PREFERIDAS.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const salida: Plan[] = [];
  let quedan = true;
  while (quedan) {
    quedan = false;
    for (const clase of orden) {
      const siguiente = baldes.get(clase)!.shift();
      if (siguiente) {
        salida.push(siguiente);
        quedan = true;
      }
    }
  }
  return salida;
}

function lineaDePlan(p: Plan, cat: CatalogoDomos): string {
  const clases = clasesDePlan(p, cat);
  const alojamiento = clases.length > 0 ? ` (${clases.join(" o ")})` : "";
  const cap = capacidadDePlan(p, cat);
  const personas = cap ? ` — hasta ${textoPersonas(cap)}` : "";
  return `• ${limpiar(p.nombre)}${alojamiento}${personas}\n   ${preciosDe(p)}`;
}

// ---- Tarifa según la fecha ----------------------------------------------------------------

export type Tarifa = "entre_semana" | "fin_de_semana" | "fin_de_semana_puente";

export const ETIQUETA_TARIFA: Record<Tarifa, string> = {
  entre_semana: "de lunes a jueves",
  fin_de_semana: "de viernes a domingo",
  fin_de_semana_puente: "en fin de semana de puente festivo",
};

/** El precio de esa tarifa, o null si no aplica (en la base, "no aplica" está cargado como 0). */
export function precioPara(p: Plan, t: Tarifa): number | null {
  const v =
    t === "entre_semana"
      ? p.precio_entre_semana
      : t === "fin_de_semana"
        ? p.precio_fin_de_semana
        : p.precio_fin_de_semana_puente;
  return v ? v : null;
}

/** El más barato de los precios que sí aplican — sirve para ordenar cuando no sabemos la fecha. */
function precioReferencia(p: Plan): number | null {
  const todos = [p.precio_entre_semana, p.precio_fin_de_semana, p.precio_fin_de_semana_puente].filter(
    (v): v is number => Boolean(v)
  );
  return todos.length > 0 ? Math.min(...todos) : null;
}

/**
 * Qué tarifa corresponde a una fecha AAAA-MM-DD. Viernes, sábado y domingo son fin de semana.
 * El recargo de puente festivo NO se puede deducir de la fecha sola (haría falta el calendario
 * de festivos de Colombia), así que solo se aplica si el cliente aclara que es puente y el
 * modelo pasa `festivo: true`.
 */
export function tarifaDeFecha(fechaISO: string, festivo?: boolean): Tarifa | null {
  const m = limpiar(fechaISO).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  const dia = d.getUTCDay(); // 0 domingo ... 6 sábado
  const esFinDeSemana = dia === 0 || dia === 5 || dia === 6;
  if (!esFinDeSemana) return "entre_semana";
  return festivo ? "fin_de_semana_puente" : "fin_de_semana";
}

// ---- Ganchos de venta y ocasión ------------------------------------------------------------

/**
 * Lo más apetecible que menciona la descripción del plan, en orden de qué tanto vende. Solo
 * nombra cosas que están LITERALMENTE escritas en la descripción — nunca inventa un beneficio.
 */
const GANCHOS: [RegExp, string, string][] = [
  // [patrón, cómo se le dice al cliente, grupo]. El grupo evita decir dos versiones de lo
  // mismo ("spa premium en pareja, spa en pareja"): solo entra la primera de cada grupo, y
  // están ordenadas de la más apetecible a la más común.
  [/spa premium/i, "spa premium en pareja", "spa"],
  [/spa/i, "spa en pareja", "spa"],
  [/turco/i, "turco selvático", "turco"],
  [/cama flotante/i, "cama flotante", "cama"],
  [/puerta panor[aá]mica/i, "puerta panorámica de cristal", "vista"],
  [/c[ií]ne?ma privado|cinema|cine privado/i, "cine privado en el chalet", "cine"],
  [/decoraci[oó]n premium/i, "decoración premium", "decoracion"],
  [/decoraci[oó]n/i, "decoración", "decoracion"],
  [/tr[ií]o coctel|coctel/i, "trío de coctelería", "coctel"],
  [/cena/i, "cena", "cena"],
  [/video recuerdo/i, "video recuerdo", "video"],
  [/jacuzzi/i, "jacuzzi", "jacuzzi"],
  [/fogata/i, "fogata", "fogata"],
  [/quebrada/i, "quebrada natural", "quebrada"],
  [/malla catamar[aá]n/i, "malla catamarán", "malla"],
  [/desayuno/i, "desayuno", "desayuno"],
];

function ganchosDe(p: Plan, cuantos = 3): string {
  const texto = limpiar(p.descripcion);
  const encontrados: string[] = [];
  const grupos = new Set<string>();
  for (const [re, etiqueta, grupo] of GANCHOS) {
    if (encontrados.length >= cuantos) break;
    if (grupos.has(grupo)) continue;
    if (re.test(texto)) {
      grupos.add(grupo);
      encontrados.push(etiqueta);
    }
  }
  return encontrados.join(", ");
}

/** Qué tan bien le va un plan a la ocasión que contó el cliente (aniversario, familia...). */
const OCASIONES: Record<string, RegExp[]> = {
  aniversario: [/decoraci[oó]n/i, /spa/i, /cena/i, /coctel/i, /premium|vip|para[ií]so/i],
  cumpleanos: [/decoraci[oó]n/i, /cena/i, /coctel/i, /fogata/i],
  luna_de_miel: [/premium|vip|para[ií]so/i, /spa/i, /decoraci[oó]n/i, /cena/i],
  pedida_de_mano: [/decoraci[oó]n premium/i, /coctel/i, /cena/i, /video recuerdo/i],
  familia: [/familia/i, /sof[aá] cama/i, /ni[nñ]o/i, /juegos de mesa/i],
  amigas: [/amigas/i, /sof[aá] cama/i],
  amigos: [/amigas|amigos/i, /sof[aá] cama/i],
  descanso: [/descanso/i, /spa/i, /turco/i],
  trabajo: [/pasad[ií]a/i],
};

function puntajeOcasion(p: Plan, ocasion?: string): number {
  if (!ocasion) return 0;
  const clave = sinTildes(ocasion).trim().replace(/\s+/g, "_");
  const patrones =
    OCASIONES[clave] ?? Object.entries(OCASIONES).find(([k]) => clave.includes(k) || k.includes(clave))?.[1];
  if (!patrones) return 0;
  const texto = `${p.nombre ?? ""} ${p.descripcion ?? ""}`;
  return patrones.reduce((acc, re) => acc + (re.test(texto) ? 1 : 0), 0);
}

// ---- Segmento: el tipo de grupo, que es lo PRIMERO que pregunta el equipo ----------------

/**
 * En el CRM el embudo está segmentado por tipo de grupo (hay etapas separadas para "familias",
 * "personas solas", "plan chicas" y "pasadía"), y las vendedoras preguntan eso antes que
 * cualquier otra cosa. Los planes del catálogo ya vienen armados por segmento, así que basta
 * con leerlo del nombre.
 *
 * Capacidades reales, confirmadas por el equipo:
 *   pareja  -> 2 personas
 *   familia -> hasta 4 (2 adultos y 2 niños) o máximo 3 adultos
 *   amigas  -> máximo 3 personas
 *   solo    -> 1 persona
 */
export type Segmento = "pareja" | "familia" | "amigas" | "solo" | "pasadia";

/**
 * [2026-09-09] Si el cliente dijo cuántas personas son pero no dijo el segmento, se deduce:
 * 2 es pareja, 1 va solo, 4 es familia. Sin esto, a una pareja le aparecía el "PLAN AMIGAS
 * 3 PERSONAS" entre las opciones (le cabe por número, pero no es lo que le estamos
 * vendiendo). El 3 queda a propósito sin deducir: puede ser amigas o familia de 3, y ahí sí
 * conviene mostrar las dos cosas hasta que el cliente aclare.
 */
function segmentoPorPersonas(personas: number): Segmento | undefined {
  if (personas === 0) return "pareja"; // nada dicho todavía: el caso más común
  if (personas === 1) return "solo";
  if (personas === 2) return "pareja";
  if (personas >= 4) return "familia";
  return undefined;
}

export function segmentoDePlan(p: Plan): Segmento {
  const nombre = sinTildes(p.nombre ?? "");
  if (/pasadia/.test(nombre)) return "pasadia";
  if (/amigas|amigos|chicas/.test(nombre)) return "amigas";
  if (/familiar|familia/.test(nombre)) return "familia";
  if (/una persona|1 persona/.test(nombre)) return "solo";
  return "pareja";
}

// ---- Los tres niveles de experiencia (así vende el equipo, ver ANALISIS-VENTAS-KOMMO) ----

/**
 * En el CRM las vendedoras NUNCA listan los 20 planes: ofrecen tres niveles de experiencia
 * ("planes por noche", "intermedios", "todo incluido") con un "desde $X" y cierran con
 * "¿cuál de estas experiencias quieres vivir?". El nombre del plan puntual aparece después,
 * cuando el cliente ya eligió un nivel. Esto replica ese guion con los precios reales de la
 * base, en vez de textos fijos que se desactualizan.
 */
type Nivel = "por_noche" | "intermedio" | "todo_incluido";

const TITULO_NIVEL: Record<Nivel, string> = {
  por_noche: "🏕️🌙 Planes por noche",
  intermedio: "💛 Planes intermedios",
  todo_incluido: "🌟🥂 Planes todo incluido",
};

const RESUMEN_NIVEL: Record<Nivel, string> = {
  por_noche: "Incluye noche, jacuzzi y desayuno. La decoración se agrega por valor adicional 🎈",
  intermedio: "Noche, desayuno, jacuzzi, cena y decoración especial 💐",
  todo_incluido:
    "Noche, cena romántica, jacuzzi, desayuno, fogata, spa, coctelería, servicio a la habitación y más 💕🔥",
};

const ORDEN_NIVELES: Nivel[] = ["por_noche", "intermedio", "todo_incluido"];

function nivelDePlan(p: Plan): Nivel {
  const nombre = sinTildes(p.nombre ?? "");
  const todo = sinTildes(`${p.nombre ?? ""} ${p.descripcion ?? ""}`);
  const tieneSpa = /spa/.test(todo);
  const tieneCoctel = /coctel/.test(todo);
  if (/\bvip\b|paraiso/.test(nombre) || (tieneSpa && tieneCoctel)) return "todo_incluido";
  if (
    /intermedio|premium|lujo|confort/.test(nombre) ||
    tieneSpa ||
    /cena/.test(todo) ||
    /decoracion/.test(todo) ||
    /turco/.test(todo) ||
    /servicio a la habitacion/.test(todo)
  ) {
    return "intermedio";
  }
  return "por_noche";
}

/**
 * La escalera de tres: uno económico, uno recomendado y uno premium. Es la forma clásica de
 * presentar opciones en ventas — el premium hace que el del medio se vea razonable, y siempre
 * hay alguien que se va por el premium. El recomendado es el que mejor le calza a la ocasión
 * que contó el cliente; si no contó ninguna, el del medio de la banda.
 */
function armarEscalera(
  candidatos: Plan[],
  tarifa: Tarifa | null,
  ocasion?: string
): { plan: Plan; precio: number | null }[] {
  const conPrecio = candidatos
    .map((p) => ({ plan: p, precio: (tarifa ? precioPara(p, tarifa) : null) ?? precioReferencia(p) }))
    .filter((x) => x.precio != null) as { plan: Plan; precio: number }[];

  conPrecio.sort((a, b) => a.precio - b.precio);
  if (conPrecio.length <= 3) return conPrecio;

  const economico = conPrecio[0];
  const premium = conPrecio[conPrecio.length - 1];
  const medio = conPrecio.slice(1, -1);
  medio.sort((a, b) => puntajeOcasion(b.plan, ocasion) - puntajeOcasion(a.plan, ocasion) || a.precio - b.precio);
  const recomendado = ocasion ? medio[0] : medio[Math.floor(medio.length / 2)];

  return [economico, recomendado, premium];
}

/**
 * [2026-09-09] Cruza el plan con lo que devolvió LobbyPMS (ver src/core/integrations/lobbypms.ts)
 * para saber si HAY cupo de verdad, no si "cabe" por capacidad. `clasesDePlan` ya deduce chalet/
 * clasico/deluxe del nombre (mismo texto que usa LobbyPMS para sus categorías); acá solo falta
 * separar "clasico" en romantic (2p) vs familiar (4p) porque LobbyPMS los trata como categorías
 * distintas con cupo independiente.
 *
 * Devuelve `true`/`false` cuando se puede afirmar algo, `undefined` cuando no (la API falló, o
 * no reconocemos a qué categoría de LobbyPMS pertenece este plan) — con `undefined` el llamador
 * tiene que quedarse con el "le confirmo con el equipo" de siempre, nunca inventar un sí o un no.
 */
function cupoParaPlan(
  p: Plan,
  cat: CatalogoDomos,
  disponibilidad: DisponibilidadCategoria[] | null
): boolean | undefined {
  if (!disponibilidad) return undefined;
  const clases = clasesDePlan(p, cat);
  if (clases.length === 0) return undefined;
  const capacidad = capacidadDePlan(p, cat) ?? 2;

  const relevantes = disponibilidad.filter((d) => {
    if (!clases.includes(d.clase)) return false;
    if (d.clase !== "clasico") return true;
    // "clasico" cubre dos categorías reales en LobbyPMS (romantic 2p / familiar 4p) — nos
    // quedamos con la que le queda a la capacidad que pide este plan.
    return capacidad <= 2 ? d.capacidad === 2 : d.capacidad === 4;
  });
  if (relevantes.length === 0) return undefined;
  return relevantes.some((d) => d.disponibles > 0);
}

function sufijoDeCupo(cupo: boolean | undefined): string {
  if (cupo === true) return " · cupo: sí 🙌";
  if (cupo === false) return " · sin cupo esa fecha";
  return "";
}

function lineaDeEscalera(
  x: { plan: Plan; precio: number | null },
  tarifa: Tarifa | null,
  recomendado: boolean,
  cat: CatalogoDomos,
  disponibilidad: DisponibilidadCategoria[] | null = null
): string {
  const p = x.plan;
  const cap = capacidadDePlan(p, cat);
  const nombre = limpiar(p.nombre);
  const precio = x.precio != null ? formatMoney(x.precio) : "precio a confirmar con el equipo";
  const cuando = tarifa && x.precio != null ? ` ${ETIQUETA_TARIFA[tarifa]}` : "";
  const ganchos = ganchosDe(p);
  const marca = recomendado ? "⭐ Mi recomendación: " : "";
  const personas = cap ? ` (hasta ${textoPersonas(cap)})` : "";
  const cupo = sufijoDeCupo(cupoParaPlan(p, cat, disponibilidad));
  return `• ${marca}${nombre}${personas}: ${precio}${cuando}${cupo}${ganchos ? `\n   Incluye ${ganchos}.` : ""}`;
}

/**
 * Busca UN plan activo por nombre (o parte del nombre, como lo diga el cliente). Devuelve null
 * si no hay coincidencia o si hay varias, para que quien llama pregunte en vez de adivinar.
 */
export async function buscarPlanPorNombre(texto: string): Promise<Plan | null> {
  const buscado = sinTildes(limpiar(texto));
  if (!buscado) return null;
  const planes = await planesRepo.list(true);
  const coincidencias = planes.filter((p) => sinTildes(limpiar(p.nombre)).includes(buscado));
  return coincidencias.length === 1 ? coincidencias[0] : null;
}

/**
 * [2026-09-08] Historia de esta herramienta, para que no se repita:
 *
 * Primero devolvía los 20 planes con TODA su descripción en un solo texto: 16.319 caracteres
 * medidos. Un mensaje de texto de WhatsApp no puede pasar de 4.096 y, como YCloud igual acepta
 * la petición, el bot creía haber respondido y el cliente no recibía NADA, sin ningún error en
 * la consola. Después pasó a mostrar de a 3 alternando tipo de alojamiento.
 *
 * Hoy trabaja como un asesor, no como un catálogo:
 *   - `personas` + `ocasion` + `fecha` filtran y ordenan ANTES de mostrar nada;
 *   - devuelve una ESCALERA de 3 (económico / recomendado / premium) con UN solo precio, el de
 *     la fecha del cliente, y los 3 ganchos más apetecibles de cada plan;
 *   - cierra con una sola pregunta que empuja al siguiente paso (la fecha o el pase al equipo);
 *   - `pagina` 2, 3... muestra otras opciones de a 3 si el cliente quiere seguir mirando;
 *   - `plan` devuelve el detalle completo de uno solo.
 */
export const consultarPlanesTool: ToolDefinition = {
  name: "consultar_planes",
  permitirRedaccion: true,
  description:
    "Planes, precios y CUPO REAL de La Julita. Pásale SIEMPRE el `segmento` (pareja, familia, amigas, solo o pasadia) en cuanto lo sepas, y la `fecha` si la tienes. Sin `nivel` devuelve el MENÚ DE TRES EXPERIENCIAS (planes por noche / intermedios / todo incluido) con su precio 'desde' — es lo primero que se le muestra al cliente. Cuando el cliente elige una, llámala otra vez con `nivel` y devuelve hasta 3 planes concretos de ese nivel, YA con el cupo real de esa fecha (consulta el motor de reservas en línea). Con `plan` devuelve el detalle completo de uno, también con el cupo si hay `fecha`. Pásale siempre `personas` y, si la sabes, `fecha` (así cotiza un solo precio, el de ese día, Y te dice si hay cupo). Los precios y lo que incluye cada plan salen SIEMPRE de acá, nunca de tu memoria — y lo mismo la disponibilidad: si la respuesta no trae un dato de cupo explícito, no inventes uno.",
  parameters: {
    type: "object",
    properties: {
      personas: {
        type: "integer",
        description: "Para cuántas personas es. Pregúntaselo al cliente antes de mostrar planes si no lo sabes.",
      },
      ocasion: {
        type: "string",
        description:
          "Qué están celebrando, tal como lo dijo el cliente: aniversario, cumpleaños, luna de miel, pedida de mano, familia, amigas, descanso... Sirve para recomendarle el plan que mejor le calza.",
      },
      fecha: {
        type: "string",
        description:
          "Fecha de la estadía en formato AAAA-MM-DD. Con ella se cotiza UN solo precio (el que corresponde a ese día) en vez de los tres.",
      },
      festivo: {
        type: "boolean",
        description:
          "true solo si el cliente aclaró que ese fin de semana es puente festivo. Cambia la tarifa al valor de puente.",
      },
      segmento: {
        type: "string",
        enum: ["pareja", "familia", "amigas", "solo", "pasadia"],
        description:
          "El tipo de grupo, que es lo PRIMERO que hay que preguntar: 'pareja' (2 personas), 'familia' (hasta 4: 2 adultos y 2 niños, o máximo 3 adultos), 'amigas' (máximo 3), 'solo' (1 persona) o 'pasadia' (van solo de día, sin dormir).",
      },
      nivel: {
        type: "string",
        enum: ["por_noche", "intermedio", "todo_incluido"],
        description:
          "La experiencia que eligió el cliente del menú: 'por_noche' (noche, jacuzzi y desayuno), 'intermedio' (agrega cena y decoración) o 'todo_incluido' (agrega spa, coctelería, servicio a la habitación). Omítelo para mostrar el menú de las tres.",
      },
      tipo: {
        type: "string",
        enum: ["una_noche", "dos_noches", "pasadia"],
        description: "Opcional, si el cliente lo aclaró: 'pasadia' es ir de día sin dormir.",
      },
      pagina: {
        type: "integer",
        description: "Para mostrar OTRAS opciones de a 3 cuando el cliente pide seguir viendo: 2, 3, 4...",
      },
      plan: {
        type: "string",
        description:
          "Nombre (o parte del nombre) de UN plan del que el cliente quiere el detalle completo, por ejemplo 'paraiso' o 'familiar 3'.",
      },
    },
    required: [],
  },
  handler: async (
    args: {
      segmento?: Segmento;
      personas?: number;
      ocasion?: string;
      fecha?: string;
      festivo?: boolean;
      nivel?: Nivel;
      tipo?: TipoPlan;
      pagina?: number;
      plan?: string;
    },
    ctx: ToolContext
  ) => {
    const planesCrudos = await planesRepo.list(true);
    if (planesCrudos.length === 0) {
      const msg = "Todavía no tengo los planes cargados — dale la pregunta al equipo de La Julita.";
      return { result: [], reply_to_user: msg };
    }
    // [2026-09-11] La descripción se limpia UNA sola vez acá, apenas se traen los planes de la
    // base — no solo al armar el texto que lee el cliente (`detalle`, más abajo). Motivo: el
    // `result` que se le pasa al modelo para que redacte (ver `{ ...p, cupo }` y `coincidencias`
    // más abajo) lleva el plan CRUDO, descripción incluida — y esa es justo la fuente donde
    // seguía viajando el precio viejo escrito a mano. Aunque el texto que arma esta herramienta
    // ya viniera limpio, el precio viejo colado en `result.descripcion` bastaba para que la
    // verificación anti-alucinación de runTurn.ts lo diera por "válido" (revisa TODO lo que
    // devuelve la herramienta, no solo el texto) y el modelo lo repitiera igual. Limpiando acá,
    // en el único lugar donde se leen los planes, ninguna rama de abajo puede filtrar el precio
    // viejo por ningún camino.
    const planes = planesCrudos.map((p) => ({ ...p, descripcion: resolverPreciosEnDescripcion(limpiar(p.descripcion), p) }));
    const cat = await cargarCatalogoDomos();
    const tarifa = args?.fecha ? tarifaDeFecha(args.fecha, args.festivo) : null;

    // ---- Detalle de un plan puntual ----
    const buscado = sinTildes(limpiar(args?.plan));

    // [2026-09-09] Cupo real contra LobbyPMS — solo cuando ya se va a mostrar un plan concreto
    // (detalle de `plan`, o ya eligió `nivel`): en el menú de las tres experiencias todavía no
    // hay un plan puntual al que preguntarle "¿hay cupo?", así que ahí no se consulta.
    // `disponibilidad === null` significa "no se pudo confirmar" (API caída, o no aplica) — en
    // ese caso todo el código de abajo cae al "le confirmo con el equipo" de siempre.
    const disponibilidad =
      args?.fecha && (args?.nivel || buscado) ? await consultarDisponibilidad(args.fecha, 1) : null;

    // [2026-09-09] Le restamos al cupo de LobbyPMS lo que YA está bloqueado por otro cliente
    // en este mismo bot (ver src/core/db/bloqueosRepo.ts) — sin esto, dos conversaciones
    // distintas podían ver "sí hay cupo" para el mismo domo al mismo tiempo. El bloqueo de ESTA
    // conversación no se resta (si ya es suyo, para él sigue siendo "sí hay").
    if (disponibilidad && args?.fecha) {
      for (const d of disponibilidad) {
        const tomados = await contarBloqueosActivos(d.clase, d.capacidad, args.fecha, {
          canal: ctx.channel,
          externalId: ctx.externalId,
        });
        d.disponibles = Math.max(0, d.disponibles - tomados);
      }
    }

    if (buscado) {
      const coincidencias = planes.filter((p) => sinTildes(limpiar(p.nombre)).includes(buscado));

      if (coincidencias.length === 1) {
        const p = coincidencias[0];
        const cap = capacidadDePlan(p, cat);
        const personas = cap ? ` (hasta ${textoPersonas(cap)})` : "";
        const precio = tarifa ? precioPara(p, tarifa) : null;
        const lineaPrecio =
          precio != null ? `${formatMoney(precio)} ${ETIQUETA_TARIFA[tarifa as Tarifa]}` : preciosDe(p);
        const detalle = limpiar(p.descripcion); // ya viene limpio de precios viejos (ver arriba)
        const cupo = cupoParaPlan(p, cat, disponibilidad);
        const lineaCupo =
          cupo === true ? "\n\n✅ Para esa fecha SÍ tengo cupo." : cupo === false ? "\n\n❌ Para esa fecha no me queda cupo — te muestro otra opción o fecha si quieres." : "";
        // [2026-09-14] Este texto no es solo la "base" para que el modelo redacte: es lo que se
        // le manda TAL CUAL al cliente si la redacción del modelo se descarta por la
        // verificación de cifras (ver runTurn.ts). Daniel lo vio en vivo — le llegó el plan
        // entero en texto pelado, sin una negrita ni un emoji, y con razón le pareció feo. Por
        // eso ahora el texto de respaldo ya sale presentable por su cuenta: nombre en negrita
        // (un solo asterisco, que es como WhatsApp la muestra) y el precio con su emoji. El
        // cuerpo de la descripción sigue saliendo tal como está cargado en el panel.
        const texto =
          `*${limpiar(p.nombre)}*${personas}\n💰 ${lineaPrecio}` +
          `${detalle ? `\n\n${detalle}` : ""}${lineaCupo}`;
        return { result: { ...p, cupo: cupo ?? null }, reply_to_user: texto };
      }

      if (coincidencias.length > 1) {
        const texto =
          `Tengo varios que coinciden con "${limpiar(args?.plan)}":\n` +
          coincidencias.map((p) => `• ${limpiar(p.nombre)}: ${preciosDe(p)}`).join("\n") +
          "\n\n¿Cuál de esos quieres que te detalle?";
        return { result: coincidencias, reply_to_user: texto };
      }
    }

    // ---- Filtros ----
    let candidatos = planes;

    // El segmento manda: si el cliente dijo que son pareja, familia, amigas o va solo, los
    // planes de los otros segmentos no le sirven aunque le "quepan" por número de personas.
    //
    // [2026-09-08] Si todavía no se sabe el segmento ni el número de personas, se asume
    // PAREJA — es el caso más común y es exactamente lo que hace el equipo ("elige tu
    // experiencia ideal una noche dos personas"). Sin esto, el "desde" del menú salía con el
    // precio del plan de UNA persona ($339.000), un valor que una pareja no puede tomar.
    const segmentoExplicito = args?.segmento as Segmento | undefined;
    // Si pidió un pasadía por `tipo` sin decir el segmento, el segmento deducido (pareja,
    // familia...) no debe borrar los pasadías: son otro producto y sus planes no llevan
    // "pareja" en el nombre. Sin esto, "somos 2 y queremos pasadía" devolvía planes de noche.
    const segmento =
      args?.tipo === "pasadia" && !segmentoExplicito
        ? undefined
        : segmentoExplicito ?? segmentoPorPersonas(Number(args?.personas) || 0);
    if (segmento) {
      const delSegmento = candidatos.filter((p) => segmentoDePlan(p) === segmento);
      if (delSegmento.length > 0) candidatos = delSegmento;
    }

    if (args?.tipo) {
      const delTipo = candidatos.filter((p) => tipoDePlan(p) === args.tipo);
      if (delTipo.length > 0) candidatos = delTipo;
    } else if (segmento !== "pasadia") {
      // Un pasadía NO es "la versión barata" de una noche de glamping: es otro producto (se
      // van el mismo día). Mezclarlos hacía que la opción económica fuera un pasadía cuando el
      // cliente quería quedarse a dormir. Solo aparecen si los pide, por `segmento` o `tipo`.
      const soloAlojamiento = candidatos.filter((p) => tipoDePlan(p) !== "pasadia");
      if (soloAlojamiento.length > 0) candidatos = soloAlojamiento;
    }

    const personas = Number(args?.personas) || 0;
    let nota = "";
    if (personas > 0) {
      const justos = candidatos.filter((p) => capacidadDePlan(p, cat) === personas);
      const sinDato = candidatos.filter((p) => capacidadDePlan(p, cat) == null);
      const masGrandes = candidatos.filter((p) => {
        const cap = capacidadDePlan(p, cat);
        return cap != null && cap > personas;
      });
      const caben = [...justos, ...sinDato, ...masGrandes];
      if (caben.length > 0) candidatos = caben;
      else nota = `No tengo un plan armado para ${personas} personas, pero mira estos:\n`;
    }

    // Si la fecha marca una tarifa, dejamos solo los planes que se pueden vender ese día
    // (un pasadía de domingo no tiene tarifa de entre semana, y al revés).
    if (tarifa) {
      const disponibles = candidatos.filter((p) => precioPara(p, tarifa) != null);
      if (disponibles.length > 0) candidatos = disponibles;
    }

    // ---- Modo "ver otras opciones" (de a 3, alternando alojamiento) ----
    const pagina = Math.max(1, Math.floor(Number(args?.pagina) || 1));
    if (pagina > 1) {
      const ordenados = alternandoPorClase(candidatos, cat);
      const desde = (pagina - 1) * PLANES_POR_TANDA;
      const tanda = ordenados.slice(desde, desde + PLANES_POR_TANDA);
      if (tanda.length === 0) {
        return {
          result: { pagina, total_que_aplican: ordenados.length, quedan: 0 },
          reply_to_user:
            "Ya te mostré todas las opciones que tengo para eso. ¿Quieres que te cuente qué incluye alguno de los que viste?",
        };
      }
      const quedan = ordenados.length - (desde + tanda.length);
      const lineas = tanda.map((p) => {
        const precio = tarifa ? precioPara(p, tarifa) : null;
        const valor = precio != null ? `${formatMoney(precio)} ${ETIQUETA_TARIFA[tarifa as Tarifa]}` : preciosDe(p);
        const ganchos = ganchosDe(p, 2);
        return `• ${limpiar(p.nombre)}: ${valor}${ganchos ? `\n   Incluye ${ganchos}.` : ""}`;
      });
      const cierre =
        quedan > 0
          ? "¿Alguno de estos te late, o te muestro más?"
          : "Esos son todos los que tengo para eso. ¿Cuál te gustaría que te detalle?";
      return {
        result: { mostrados: tanda.map((p) => p.nombre), pagina, total_que_aplican: ordenados.length, quedan },
        reply_to_user: `${lineas.join("\n")}\n\n${cierre}`,
      };
    }

    // ---- Menú de las tres experiencias (el pitch que usa el equipo) ----
    // Es el modo por defecto: mientras el cliente no haya elegido un nivel, no se le tiran
    // nombres de planes sino tres niveles con "desde $X" y una pregunta de elección.
    const nivelPedido = args?.nivel as Nivel | undefined;
    if (!nivelPedido) {
      // Con pocos planes (por ejemplo el segmento "amigas", que tiene uno solo) un menú de
      // niveles es una vuelta al vacío: se muestran directo.
      const disponibles = candidatos
        .map((p) => ({ plan: p, precio: (tarifa ? precioPara(p, tarifa) : null) ?? precioReferencia(p) }))
        .filter((x) => x.precio != null) as { plan: Plan; precio: number }[];

      // [2026-09-09] Un pasadía NO tiene "niveles de experiencia": no hay noche que incluir,
      // así que el menú de tres ("Planes por noche — Incluye noche, jacuzzi y desayuno")
      // quedaba diciendo mentiras y metía el precio del pasadía como el "desde" de una
      // noche. Sus versiones son básico / intermedio / premium: se muestran directo.
      const soloPasadias =
        candidatos.length > 0 && candidatos.every((p) => tipoDePlan(p) === "pasadia");
      if (soloPasadias && disponibles.length > PLANES_POR_TANDA) {
        const escaleraDia = armarEscalera(candidatos, tarifa, args?.ocasion);
        const lineasDia = escaleraDia.map((x, i) =>
          lineaDeEscalera(x, tarifa, escaleraDia.length >= 3 && i === 1, cat)
        );
        const cierreDia = args?.fecha
          ? "Los valores son sin IVA. ¿Cuál te gustaría tomar? Con ese dato le pido al equipo que te confirme el cupo para esa fecha."
          : "Los valores son sin IVA. ¿Para qué día lo tienen pensado? Con eso te confirmo el valor exacto y el cupo.";
        const encabezadoDia =
          nota ||
          `☀️ Pasadías${personas > 0 ? ` para ${textoPersonas(personas)}` : ""}${tarifa ? ` ${ETIQUETA_TARIFA[tarifa]}` : ""} (van de día, sin dormir):\n`;
        return {
          result: {
            modo: "pasadias",
            mostrados: escaleraDia.map((x) => x.plan.nombre),
            tarifa,
            personas: personas || null,
            total_que_aplican: candidatos.length,
          },
          reply_to_user: `${encabezadoDia}${lineasDia.join("\n")}\n\n${cierreDia}`,
        };
      }

      if (disponibles.length > 0 && disponibles.length <= PLANES_POR_TANDA) {
        disponibles.sort((a, b) => a.precio - b.precio);
        const lineas = disponibles.map((x, i) =>
          lineaDeEscalera(x, tarifa, disponibles.length >= 3 && i === 1, cat)
        );
        const cierre = args?.fecha
          ? "Los valores son sin IVA. ¿Cuál te gustaría tomar? Con ese dato le pido al equipo que te confirme el cupo para esa fecha."
          : "Los valores son sin IVA. ¿Para qué fecha lo tienen pensado? Con eso te confirmo el valor exacto y el cupo.";
        return {
          result: {
            modo: "planes",
            mostrados: disponibles.map((x) => x.plan.nombre),
            segmento: segmento ?? null,
            tarifa,
            personas: personas || null,
          },
          reply_to_user: `${nota}${lineas.join("\n")}\n\n${cierre}`,
        };
      }

      const porNivel = new Map<Nivel, { plan: Plan; precio: number }[]>();
      for (const p of candidatos) {
        const precio = (tarifa ? precioPara(p, tarifa) : null) ?? precioReferencia(p);
        if (precio == null) continue;
        const nivel = nivelDePlan(p);
        if (!porNivel.has(nivel)) porNivel.set(nivel, []);
        porNivel.get(nivel)!.push({ plan: p, precio });
      }

      const bloques: string[] = [];
      for (const nivel of ORDEN_NIVELES) {
        const lista = porNivel.get(nivel);
        if (!lista || lista.length === 0) continue;
        const desde = Math.min(...lista.map((x) => x.precio));
        bloques.push(`${TITULO_NIVEL[nivel]}\n${RESUMEN_NIVEL[nivel]}\nDesde ${formatMoney(desde)}`);
      }

      if (bloques.length === 0) {
        return {
          result: { total_que_aplican: 0 },
          reply_to_user:
            "Para esa combinación no tengo un plan con precio cargado — dejame pasarle el caso al equipo de La Julita para que te coticen bien.",
        };
      }

      const paraQuien = personas > 0 ? ` para ${textoPersonas(personas)}` : "";
      const cuando = tarifa ? ` ${ETIQUETA_TARIFA[tarifa]}` : "";
      const cabecera = nota || `Elige tu experiencia ideal${paraQuien}${cuando}:\n`;
      const texto =
        `${cabecera}\n${bloques.join("\n\n")}\n\n` +
        "Los valores son sin IVA. ¿Cuál de estas experiencias quieres vivir? 💑✨";

      return {
        result: {
          modo: "experiencias",
          niveles: [...porNivel.entries()].map(([nivel, lista]) => ({
            nivel,
            desde: Math.min(...lista.map((x) => x.precio)),
            planes: lista.length,
          })),
          tarifa,
          personas: personas || null,
        },
        reply_to_user: texto,
      };
    }

    // ---- Ya eligió un nivel: hasta 3 planes concretos de ese nivel ----
    const delNivel = candidatos.filter((p) => nivelDePlan(p) === nivelPedido);
    const escalera = armarEscalera(delNivel.length > 0 ? delNivel : candidatos, tarifa, args?.ocasion);
    if (escalera.length === 0) {
      return {
        result: { total_que_aplican: 0 },
        reply_to_user:
          "Para esa combinación no tengo un plan con precio cargado — dejame pasarle el caso al equipo de La Julita para que te coticen bien.",
      };
    }

    const indiceRecomendado = escalera.length >= 3 ? 1 : -1;
    const lineas = escalera.map((x, i) => lineaDeEscalera(x, tarifa, i === indiceRecomendado, cat, disponibilidad));

    // Aviso honesto: si cotizamos fin de semana normal pero ese plan tiene tarifa distinta de
    // puente, el cliente tiene que saberlo antes de que se lo cobren.
    const avisoPuente =
      tarifa === "fin_de_semana" &&
      escalera.some((x) => {
        const puente = precioPara(x.plan, "fin_de_semana_puente");
        return puente != null && puente !== precioPara(x.plan, "fin_de_semana");
      })
        ? "\nOjo: si ese fin de semana cae puente festivo, la tarifa cambia — dime la fecha exacta y te confirmo."
        : "";

    const encabezado =
      nota || `${TITULO_NIVEL[nivelPedido]}${personas > 0 ? ` para ${textoPersonas(personas)}` : ""}:\n`;
    // [2026-09-09] Si SÍ pudimos confirmar cupo con LobbyPMS ya no tiene sentido cerrar
    // pidiéndole al cliente que espere a que "el equipo confirme" — ya se lo dijimos línea
    // por línea arriba (✅/·sin cupo). Si la consulta no se pudo hacer (disponibilidad===null),
    // sigue el cierre de siempre.
    const cierre = !args?.fecha
      ? "Los valores son sin IVA. ¿Para qué fecha lo tienen pensado? Con eso te confirmo el valor exacto y el cupo."
      : disponibilidad
        ? "Los valores son sin IVA. ¿Cuál te gustaría tomar?"
        : "Los valores son sin IVA. ¿Cuál te gustaría tomar? Con ese dato le pido al equipo que te confirme el cupo para esa fecha.";

    const texto = `${encabezado}${lineas.join("\n")}${avisoPuente}\n\n${cierre}`;
    return {
      result: {
        mostrados: escalera.map((x) => x.plan.nombre),
        tarifa,
        ocasion: args?.ocasion ?? null,
        personas: personas || null,
        total_que_aplican: candidatos.length,
      },
      reply_to_user: texto,
    };
  },
};

export const consultarAdicionalesTool: ToolDefinition = {
  name: "consultar_adicionales",
  permitirRedaccion: true,
  description:
    "Devuelve los servicios adicionales disponibles en La Julita (desayuno extra, jacuzzi, decoración, transporte, etc.) con su precio. Úsala si el cliente pregunta por extras — nunca inventes un precio tú mismo.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async () => {
    const adicionales = await adicionalesRepo.list(true);
    if (adicionales.length === 0) {
      const msg = "Todavía no tengo los adicionales cargados — dale la pregunta al equipo de La Julita.";
      return { result: [], reply_to_user: msg };
    }
    // En la base, `nombre` suele ser la categoría ("SPA") y `descripcion` el adicional concreto
    // ("SPA PREMIUM DOS PERSONAS"), así que se muestra la descripción cuando existe: si no,
    // salían tres líneas que decían "SPA" y el cliente no distinguía cuál era cuál.
    const texto = adicionales
      .map((a) => {
        const etiqueta = limpiar(a.descripcion) || limpiar(a.nombre);
        const precio = a.precio ? formatMoney(a.precio) : "precio a confirmar con el equipo";
        return `• ${etiqueta}: ${precio}`;
      })
      .join("\n") + "\n\nLos valores son sin IVA. ¿Quieres que le sume alguno a tu reserva?";
    return { result: adicionales, reply_to_user: texto };
  },
};

export const consultarHorariosTool: ToolDefinition = {
  name: "consultar_horarios",
  description: "Devuelve el horario de check-in y check-out de La Julita.",
  parameters: { type: "object", properties: {}, required: [] },
  handler: async () => {
    const config = await getConfiguracion();
    const checkin = config["checkin"];
    const checkout = config["checkout"];
    if (!checkin || !checkout) {
      const msg = "Todavía no tengo esos horarios cargados — dale la pregunta al equipo de La Julita.";
      return { result: {}, reply_to_user: msg };
    }
    const texto = `El check-in es a partir de las ${checkin} y el check-out es hasta las ${checkout}.`;
    return { result: { checkin, checkout }, reply_to_user: texto };
  },
};
