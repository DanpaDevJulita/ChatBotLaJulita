/**
 * Datos REALES de la base de La Julita, tomados de Supabase el 2026-09-11 (proyecto
 * wcjoqkvkdnueadkcbupr). Se usan para correr el bot entero sin salir a la red.
 *
 * Lo importante para esta prueba: las líneas de precio de las descripciones están COPIADAS
 * TAL CUAL de la base — son las que el filtro tiene que cazar. La descripción del PLAN
 * FAMILIAR 3 PERSONAS (id 30), que es el caso que falló en WhatsApp, va completa y textual.
 */

export interface FilaPlan {
  id: number;
  nombre: string;
  descripcion: string;
  precio_entre_semana: number;
  precio_fin_de_semana: number;
  precio_fin_de_semana_puente: number;
  domos_id: number[];
  activo: boolean;
}

/** Descripción textual del plan 30, tal cual está hoy en la base (con \r\n de Windows). */
const DESCRIPCION_FAMILIAR_3 =
  "Plan Familia una noche\r\n\r\nIncluye:\r\nBienvenida\r\nHabitación tipo domo clasico\r\n" +
  "Desayuno para 3 personas\r\nCama Queen\r\nSofá cama\r\nMalla catamarán\r\nJacuzzi\r\nFogata\r\n" +
  "Parlante Bluetooth\r\nParqueadero\r\nJuegos de mesa\r\nBaño privado con ducha caliente\r\n" +
  "Acceso a quebrada natural\r\nVentilador\r\nMinibar (consumo adicional)\r\n\r\n" +
  "*Desayuno en el restaurante*\r\n\r\n" +
  "Check in (ingreso): Desde las 3 pm máxima hora de llegada 8:00 pm\r\n" +
  "Check out (salida): Medio día\r\n\r\n" +
  "Valor para tres personas una noche (padres e hijos)\r\n" +
  "Entre semana (lunes a viernes): $590.000\r\n" +
  "Fin de semana (sábado o domingo): $760.000\r\n" +
  "Sábado o domingo puente festivo $860.000\r\n\r\n" +
  "Máximo 4 personas (dos adultos y dos niños)\r\n>3 años $50.000\r\n>5 años $70.000\r\n\r\n" +
  "Precio sin IVA";

/** Líneas de precio textuales de los otros planes que también las traen escritas a mano. */
const LINEAS_PRECIO: Record<number, string[]> = {
  3: ["Cena: dos platos fuertes y dos bebidas (bebidas de hasta $10.000) "],
  28: [
    "Entre semana domo clásico o chalet (lunes a jueves): $339.000",
    "Domo  Deluxe (lunes a jueves) $569.000",
    "Fin de semana (viernes, sábado o domingo) domo clásico o chalet: $679.000",
    "Domo  deluxe: $1.090.000",
    "Fin de semana festivo (viernes, sábado o domingo) domo clásico chalet: $779.000",
    "Domo Deluxe $1.139.000",
  ],
  31: [
    "Entre semana (lunes a viernes): $590.000",
    "Fin de semana (sábado o domingo): $760.000",
    "Sábado o domingo puente festivo $860.000",
    ">3 años $50.000",
    ">5 años $70.000",
  ],
  32: [
    "Entre semana (lunes a viernes): $590.000",
    "Fin de semana (sábado o domingo): $790.000",
    "Sábado o domingo puente festivo $890.000",
  ],
};

function descripcionDe(id: number, nombre: string): string {
  if (id === 30) return DESCRIPCION_FAMILIAR_3;
  const lineas = LINEAS_PRECIO[id];
  const base = `${nombre}\r\nIncluye:\r\nBienvenida\r\nDesayuno\r\nJacuzzi\r\nFogata\r\nParqueadero`;
  return lineas ? `${base}\r\n\r\nValores:\r\n${lineas.join("\r\n")}\r\n\r\nPrecio sin IVA` : base;
}

// [id, nombre, entre_semana, fin_de_semana, puente, domos_id, activo] — copiado de la base.
const CRUDO: [number, string, number, number, number, number[], boolean][] = [
  [2, "PLAN BASICO UNA NOCHE PARA DOS PERSONAS", 569000, 690000, 790000, [1], true],
  [3, "PLAN DESCANSO PREMIUM PARA DOS PERSONAS", 790000, 890000, 990000, [1], true],
  [21, "PLAN CLASICO VIP UNA NOCHE DOS PERSONAS", 1279000, 1379000, 1479000, [1], true],
  [22, "PLAN CONFORT UNA NOCHE PARA DOS PERSONAS", 959000, 1089000, 0, [1], true],
  [23, "PLAN LUJO UNA NOCHE PARA DOS PERSONAS", 999000, 1029000, 0, [1], true],
  [24, "PLANES BASICO DOS NOCHES DOS PERSONAS", 769000, 879000, 1139000, [1], true],
  [25, "PLAN INTERMEDIO DOS NOCHES DOS PERSONAS", 1019000, 1139000, 1419000, [1], true],
  [26, "PLAN PREMIUM DOS NOCHES DOS PERSONAS", 1139000, 1259000, 1529000, [1], true],
  [27, "PLAN PARAISO UNA NOCHE DOS PERSONAS", 1490000, 3000000, 0, [1], true],
  [28, "PLAN UNA PERSONA UNA NOCHE DOMO CLASICO O CHALET", 1000, 679000, 779000, [1], true],
  [29, "PLAN UNA PERSONA UNA NOCHE DOMO DELUXE", 1000, 1090000, 1139000, [1], true],
  [30, "PLAN FAMILIAR 3 PERSONAS", 1000, 760000, 860000, [1], true],
  [31, "PLAN FAMILIAR 4 PERSONAS", 660000, 830000, 930000, [1], true],
  [32, "PLAN AMIGAS 3 PERSONAS", 590000, 760000, 930000, [1], true],
  [33, "PASADIA BASICO ENTRE SEMANA (LUNES A VIERNES)", 3690000, 0, 0, [1], true],
  [34, "PASADIA INTERMEDIO DOS PERSONAS ENTRE SEMANA", 419000, 0, 0, [1], true],
  [35, "PASADIA PREMIUM DOS PERSONAS ENTRE SEMANA", 639000, 0, 0, [1], true],
  [36, "PASADIA BASICO DOMINGO NO FESTIVOS DOS PERSONAS", 0, 390000, 0, [1], true],
  [37, "PASADIA INTERMEDIO DOMINGO NO FESTIVOS DOS PERSONAS", 0, 549000, 0, [1], true],
  [38, "PASADIA PREMIUM DOS PERSONAS DOMINGO NO FESTIVOS", 0, 649000, 0, [1], true],
];

export const PLANES: FilaPlan[] = CRUDO.map(([id, nombre, es, fs_, pu, domos, activo]) => ({
  id,
  nombre,
  descripcion: descripcionDe(id, nombre),
  precio_entre_semana: es,
  precio_fin_de_semana: fs_,
  precio_fin_de_semana_puente: pu,
  domos_id: domos,
  activo,
}));

export const DOMOS = [
  { id: 1, clase: 1, opcion: "Familias, 2 adultos 2 niños maximo o parejas.\n ", capacidad_max: 4 },
  { id: 2, clase: 1, opcion: "Pareja", capacidad_max: 2 },
  { id: 3, clase: 1, opcion: "Familias, 2 adultos 2 niños maximo o Parejas.", capacidad_max: 4 },
  { id: 4, clase: 1, opcion: "Pareja", capacidad_max: 2 },
  { id: 5, clase: 2, opcion: "Pareja", capacidad_max: 2 },
  { id: 6, clase: 2, opcion: "Pareja", capacidad_max: 2 },
  { id: 7, clase: 2, opcion: "Pareja", capacidad_max: 2 },
  { id: 8, clase: 3, opcion: "Pareja", capacidad_max: 2 },
];

export const CLASES = [
  { id: 1, nombre: "Clasico" },
  { id: 2, nombre: "Delux" },
  { id: 3, nombre: "Chalet" },
];

/** El plan del caso que falló, y su precio real de entre semana hoy. */
export const PLAN_PROBADO = PLANES.find((p) => p.id === 30)!;
export const PRECIO_REAL_ENTRE_SEMANA = PLAN_PROBADO.precio_entre_semana; // 1000
/** El precio viejo que quedó pegado en la descripción y que NO debe salir nunca. */
export const PRECIO_VIEJO_EN_DESCRIPCION = "590000";
