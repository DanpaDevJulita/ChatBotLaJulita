import axios from "axios";

/**
 * Disponibilidad REAL de La Julita contra LobbyPMS. Hay DOS caminos y el orden importa:
 *
 *   1. [2026-09-10] API OFICIAL — https://api.lobbypms.com/api/v1/available-rooms
 *      Autenticada con `api_token` (LOBBYPMS_API_TOKEN en el .env) y devuelve el cupo
 *      DÍA POR DÍA: `[{ date, name, available_rooms }]`. Es la fuente primaria porque es un
 *      contrato oficial y porque el detalle por día es lo único que permite (a) afirmar cupo en
 *      estadías de varias noches y (b) ofrecerle al cliente OTRA fecha cuando la suya no tiene
 *      cupo (ver buscarFechasAlternativas, que usa el agente de postventa).
 *
 *      OJO: además del token, LobbyPMS exige que la IP de salida esté autorizada en su panel
 *      (Configuraciones -> API -> restricciones de IP). Si no lo está responde 403 con
 *      "...trying to access the API is not set as a valid ip". Por eso el bot NUNCA depende solo
 *      de esta vía: cualquier fallo cae al camino 2 y el cliente no se queda sin respuesta.
 *
 *   2. MOTOR PÚBLICO (respaldo) — https://engine.lobbypms.com/api/engine/load-rooms
 *      El mismo endpoint interno que usa el widget de reservas del sitio: sin token y sin
 *      restricción de IP, pero NO es una API pública documentada (puede cambiar sin aviso) y
 *      devuelve un AGREGADO del rango, no el detalle por día.
 *
 * Regla que vale para todo este archivo: ninguna función lanza. Devuelven `null` cuando no se
 * pudo confirmar, y quien llama SIEMPRE tiene que tratar `null` como "no pude confirmar",
 * nunca como "no hay cupo".
 */

// --- Configuración -------------------------------------------------------------------------

const API_OFICIAL_URL = (process.env.LOBBYPMS_API_URL ?? "https://api.lobbypms.com/api/v1").replace(/\/+$/, "");
const API_TOKEN = (process.env.LOBBYPMS_API_TOKEN ?? "").trim();

const MOTOR_PUBLICO_URL = "https://engine.lobbypms.com/api/engine/load-rooms";
const PROPERTY_ID = 16392; // id del establecimiento "La Julita Glamping" en LobbyPMS
const LANG_CODE = 1; // español

const TIMEOUT_MS = 10_000;

const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-19" -> "19-Dec-2026" (el formato que espera el motor público). */
function aFechaLobby(fechaISO: string): string | null {
  const m = fechaISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, anio, mesNum, dia] = m;
  const mes = MESES[Number(mesNum) - 1];
  if (!mes) return null;
  return `${Number(dia)}-${mes}-${anio}`;
}

/** "2026-12-19" + 1 -> "2026-12-20". */
export function sumarDias(fechaISO: string, dias: number): string | null {
  const m = fechaISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + dias);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Las 4 categorías reales en LobbyPMS, mapeadas a las clases de domo que usa el bot
 * (chalet/clasico/deluxe, ver clasesDePlan en catalogo.ts) — mapeo confirmado por el equipo
 * el 2026-09-09: "domo romantic es el mismo clasico pero solo capacidad 2 personas, domo
 * familiar es el clasico con capacidad de 4 personas".
 *
 * Las dos vías (API oficial y motor público) usan EXACTAMENTE los mismos nombres de categoría,
 * así que este mapeo sirve para ambas.
 */
export type ClaseDomoBot = "chalet" | "clasico" | "deluxe";

interface CategoriaLobby {
  clase: ClaseDomoBot;
  capacidad: number;
}

const CATEGORIAS_LOBBY: Record<string, CategoriaLobby> = {
  CHALET: { clase: "chalet", capacidad: 2 },
  "DOMO DELUXE": { clase: "deluxe", capacidad: 2 },
  "DOMO ROMANTIC": { clase: "clasico", capacidad: 2 },
  "DOMO FAMILIAR": { clase: "clasico", capacidad: 4 },
};

export interface DisponibilidadCategoria {
  nombreLobby: string;
  clase: ClaseDomoBot;
  capacidad: number;
  disponibles: number; // cuántas unidades de esa categoría quedan libres para el rango pedido
  /**
   * [2026-09-10] Id de la categoría en LobbyPMS. Solo lo trae la API oficial, y es OBLIGATORIO
   * para bloquear cupo (POST /block) y para crear una reserva (POST /bookings) — el nombre no
   * sirve para esos endpoints.
   */
  categoryId?: number;
  /**
   * Estadía mínima que exige LobbyPMS para esa categoría/fecha (`restrictions.min_stay`).
   * 0 o ausente = sin restricción. Si es mayor que las noches que pide el cliente, esa categoría
   * NO se puede vender para esa estadía aunque figure con unidades libres.
   */
  minStay?: number;
}

/** El cupo de UN día concreto, por categoría (solo lo da la API oficial). */
export interface DisponibilidadDia {
  fecha: string; // AAAA-MM-DD
  categorias: DisponibilidadCategoria[];
}

/** Para el diagnóstico: por qué no se pudo usar la API oficial. */
export type EstadoApiOficial =
  | "ok"
  | "sin_token"
  | "ip_no_autorizada"
  | "token_invalido"
  | "respuesta_inesperada"
  | "error_red";

let ultimoEstadoOficial: EstadoApiOficial | null = null;
let yaAvisoSinToken = false;

/** Último resultado conocido de la API oficial — lo usa scripts/diagnostico.ts para reportar. */
export function estadoUltimaConsultaOficial(): EstadoApiOficial | null {
  return ultimoEstadoOficial;
}

export function apiOficialConfigurada(): boolean {
  return API_TOKEN.length > 0;
}

/** Clasifica el error de la API oficial leyendo lo que ella misma devuelve. */
function clasificarError(err: unknown): EstadoApiOficial {
  const respuesta = (err as any)?.response;
  if (!respuesta) return "error_red";
  const cuerpo = JSON.stringify(respuesta.data ?? "");
  if (/not set as a valid ip/i.test(cuerpo)) return "ip_no_autorizada";
  if (/unauthenticated|unauthorized|invalid.*token/i.test(cuerpo)) return "token_invalido";
  return "respuesta_inesperada";
}

/**
 * [2026-09-10] Resumen corto de un error de red. Antes acá se hacía `console.error(..., err)` con
 * el AxiosError completo: eso escupía cientos de líneas (toda la config, headers y el
 * ClientRequest) por CADA mensaje de cliente cuando LobbyPMS estaba caído, y hacía ilegible el
 * log justo cuando más se necesita leerlo.
 */
function resumirError(err: unknown): string {
  const e = err as any;
  const status = e?.response?.status;
  const cuerpo = e?.response?.data != null ? JSON.stringify(e.response.data).slice(0, 200) : "";
  const partes = [
    status ? `HTTP ${status}` : null,
    e?.code ? String(e.code) : null,
    e?.message ? String(e.message).slice(0, 120) : null,
    cuerpo || null,
  ].filter(Boolean);
  return partes.join(" — ") || String(err).slice(0, 200);
}

function explicar(estado: EstadoApiOficial): string {
  switch (estado) {
    case "ip_no_autorizada":
      return (
        "LobbyPMS rechazó la IP de este servidor. Hay que autorizarla en el panel de LobbyPMS " +
        "(Configuraciones -> API -> restricciones de IP). Mientras tanto el bot usa el motor público."
      );
    case "token_invalido":
      return "LOBBYPMS_API_TOKEN no es válido o fue rotado — revisá el token en el panel de LobbyPMS.";
    case "respuesta_inesperada":
      return "la API oficial respondió algo que no reconocemos — puede haber cambiado de forma.";
    case "error_red":
      return "no hubo respuesta de la API oficial (red, DNS o timeout).";
    default:
      return "";
  }
}

// --- Camino 1: API oficial -----------------------------------------------------------------

/**
 * GET /api/v1/available-rooms con el detalle DÍA POR DÍA.
 *
 * `end_date` es INCLUSIVO: es la ÚLTIMA NOCHE que se consulta, NO el día de salida. Para una
 * noche del 11, se pide `start_date=11` y `end_date=11`.
 *
 * [2026-09-11] Esto estaba al revés y causaba un bug real: el código asumía el rango
 * `[entrada, salida)` y mandaba `end_date = entrada + noches`, o sea una noche de más. Medido
 * contra la API (ver scripts/diagnostico-cupo.ts):
 *
 *     start_date=2026-09-11  end_date=2026-09-11  ->  contesta por 1 fecha: el 11
 *     start_date=2026-09-11  end_date=2026-09-12  ->  contesta por 2 fechas: el 11 y el 12
 *
 * Como `agregarPorRango` exige cupo en TODAS las fechas que contesta (toma el mínimo, que es lo
 * correcto para una estadía de varias noches), pedir una noche de más hacía que el bot le dijera
 * "no hay cupo" al cliente cada vez que la noche SIGUIENTE estaba llena, aunque la suya
 * estuviera libre. Caso real: el DOMO FAMILIAR del 11 de septiembre tenía 1 unidad libre y el
 * 12 tenía 0 — el bot lo reportó como sin cupo.
 */
export async function consultarDisponibilidadPorDia(
  fechaEntradaISO: string,
  noches = 1
): Promise<DisponibilidadDia[] | null> {
  if (!API_TOKEN) {
    ultimoEstadoOficial = "sin_token";
    if (!yaAvisoSinToken) {
      console.warn(
        "[lobbypms] LOBBYPMS_API_TOKEN no está configurado: se usa solo el motor público " +
          "(sin detalle por día, así que no se pueden ofrecer fechas alternativas)."
      );
      yaAvisoSinToken = true;
    }
    return null;
  }

  // La última noche del rango, que es lo que espera `end_date` (inclusivo): 1 noche -> la misma
  // fecha de entrada; 2 noches -> entrada + 1; etc.
  const ultimaNocheISO = sumarDias(fechaEntradaISO, Math.max(1, noches) - 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaEntradaISO) || !ultimaNocheISO) {
    console.error(`[lobbypms] fecha inválida: ${fechaEntradaISO}`);
    return null;
  }

  try {
    // La respuesta viene paginada (`meta.total_pages`). Con `paginate=100` un rango de hasta 100
    // días entra en una sola página, pero se recorren igual por si acaso, con un tope de seguridad.
    const porFecha = new Map<string, DisponibilidadCategoria[]>();
    const MAX_PAGINAS = 5;
    let pagina = 1;
    let totalPaginas = 1;

    do {
      const res = await axios.get(`${API_OFICIAL_URL}/available-rooms`, {
        params: {
          api_token: API_TOKEN,
          start_date: fechaEntradaISO,
          end_date: ultimaNocheISO,
          paginate: 100,
          page: pagina,
        },
        timeout: TIMEOUT_MS,
        headers: { Accept: "application/json" },
      });

      const cuerpo = res.data as any;
      const filas: unknown = Array.isArray(cuerpo) ? cuerpo : cuerpo?.data;
      if (!Array.isArray(filas)) {
        ultimoEstadoOficial = "respuesta_inesperada";
        console.error(
          "[lobbypms] la API oficial no devolvió un arreglo de disponibilidad —",
          explicar("respuesta_inesperada")
        );
        return null;
      }

      totalPaginas = Number(cuerpo?.meta?.total_pages ?? 1) || 1;

      for (const fila of filas as any[]) {
        const fecha = String(fila?.date ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;

        // [2026-09-10] Forma documentada (app.lobbypms.com/api):
        //   { date, categories: [{ category_id, name, available_rooms, prices, restrictions }] }
        // El informe extraído del n8n mostraba una forma PLANA ({ date, name, available_rooms })
        // que es la que veía el agente de IA, no la que devuelve la API. Se acepta igual por si
        // algún endpoint la usa.
        const categorias: any[] = Array.isArray(fila?.categories) ? fila.categories : [fila];

        for (const cat of categorias) {
          const nombre = String(cat?.name ?? "").trim().toUpperCase();
          if (!nombre) continue;
          const mapeo = CATEGORIAS_LOBBY[nombre];
          if (!mapeo) {
            console.warn(`[lobbypms] categoría sin mapear: "${cat?.name}" — revisar CATEGORIAS_LOBBY`);
            continue;
          }
          if (!porFecha.has(fecha)) porFecha.set(fecha, []);
          porFecha.get(fecha)!.push({
            nombreLobby: String(cat.name),
            clase: mapeo.clase,
            capacidad: mapeo.capacidad,
            disponibles: Number(cat?.available_rooms ?? 0),
            categoryId: cat?.category_id != null ? Number(cat.category_id) : undefined,
            minStay: cat?.restrictions?.min_stay != null ? Number(cat.restrictions.min_stay) : undefined,
          });
        }
      }

      pagina++;
    } while (pagina <= totalPaginas && pagina <= MAX_PAGINAS);

    if (totalPaginas > MAX_PAGINAS) {
      console.warn(
        `[lobbypms] la disponibilidad vino en ${totalPaginas} páginas y solo se leyeron ${MAX_PAGINAS} — ` +
          "acortá el rango de fechas si hacen falta todas."
      );
    }

    if (porFecha.size === 0) {
      ultimoEstadoOficial = "respuesta_inesperada";
      console.error("[lobbypms] la API oficial respondió sin ninguna categoría reconocible");
      return null;
    }

    ultimoEstadoOficial = "ok";
    return [...porFecha.entries()]
      .map(([fecha, categorias]) => ({ fecha, categorias }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha));
  } catch (err) {
    const estado = clasificarError(err);
    ultimoEstadoOficial = estado;
    console.error(`[lobbypms] API oficial no disponible (${estado}): ${explicar(estado)} [${resumirError(err)}]`);
    return null;
  }
}

/**
 * Junta el detalle por día en UN número por categoría para todo el rango: solo hay cupo para la
 * estadía si TODAS sus noches lo tienen, así que se toma el mínimo. Esto corrige un problema real
 * del camino de respaldo: con un agregado del rango se podía afirmar cupo de 2 noches cuando en
 * realidad una de las dos estaba llena.
 */
function agregarPorRango(dias: DisponibilidadDia[], noches: number): DisponibilidadCategoria[] {
  const porCategoria = new Map<string, DisponibilidadCategoria>();
  // En cuántas noches del rango apareció cada categoría: si falta en alguna, no se puede afirmar
  // que la estadía completa esté disponible (ver más abajo).
  const aparicionesPorCategoria = new Map<string, number>();

  for (const dia of dias) {
    for (const cat of dia.categorias) {
      const clave = `${cat.clase}|${cat.capacidad}`;
      aparicionesPorCategoria.set(clave, (aparicionesPorCategoria.get(clave) ?? 0) + 1);
      const previo = porCategoria.get(clave);
      if (!previo) {
        porCategoria.set(clave, { ...cat });
      } else {
        previo.disponibles = Math.min(previo.disponibles, cat.disponibles);
        // De las restricciones de las noches del rango manda la más exigente.
        previo.minStay = Math.max(previo.minStay ?? 0, cat.minStay ?? 0);
        // El category_id puede faltar en el respaldo; si aparece en alguna noche, se conserva.
        if (previo.categoryId == null && cat.categoryId != null) previo.categoryId = cat.categoryId;
      }
    }
  }

  // [2026-09-10] `restrictions.min_stay` de LobbyPMS: si exige más noches de las que pide el
  // cliente, esa categoría NO se le puede vender para esta estadía, aunque figuren unidades
  // libres. Se refleja como 0 disponibles porque es lo que el resto del bot interpreta como
  // "no hay cupo para esto" (ver cupoParaPlan en src/agentes/ventas/herramientas/planes.ts).
  for (const [clave, cat] of porCategoria.entries()) {
    // Una categoría que no viene informada en TODAS las noches del rango no se puede vender para
    // la estadía completa: si LobbyPMS omite un día (en vez de mandarlo con 0), tomar el mínimo
    // de los días presentes daría un "sí hay cupo" falso.
    const apariciones = aparicionesPorCategoria.get(clave) ?? 0;
    if (dias.length > 0 && apariciones < dias.length) {
      console.warn(
        `[lobbypms] ${cat.nombreLobby} solo vino informada en ${apariciones} de ${dias.length} noche(s) ` +
          "del rango: no se ofrece para esta estadía."
      );
      cat.disponibles = 0;
      continue;
    }
    if ((cat.minStay ?? 0) > noches) {
      console.warn(
        `[lobbypms] ${cat.nombreLobby} exige mínimo ${cat.minStay} noche(s) y se pidieron ${noches}: ` +
          "no se ofrece para esta estadía."
      );
      cat.disponibles = 0;
    }
  }

  return [...porCategoria.values()];
}

// --- Camino 2: motor público (respaldo) ----------------------------------------------------

export async function consultarMotorPublico(
  fechaEntradaISO: string,
  noches = 1
): Promise<DisponibilidadCategoria[] | null> {
  const start = aFechaLobby(fechaEntradaISO);
  const fechaSalidaISO = sumarDias(fechaEntradaISO, Math.max(1, noches));
  const end = fechaSalidaISO ? aFechaLobby(fechaSalidaISO) : null;
  if (!start || !end) {
    console.error(`[lobbypms] fecha inválida: ${fechaEntradaISO}`);
    return null;
  }

  try {
    const res = await axios.post(
      MOTOR_PUBLICO_URL,
      new URLSearchParams({ propertyId: String(PROPERTY_ID), langCode: String(LANG_CODE), start, end }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        timeout: TIMEOUT_MS,
      }
    );

    const data = res.data as { roomCategories?: Record<string, any>; roomNoAvailable?: Record<string, any> };
    const todas = { ...(data.roomCategories ?? {}), ...(data.roomNoAvailable ?? {}) };
    const resultado: DisponibilidadCategoria[] = [];

    for (const cat of Object.values(todas)) {
      const nombre = String(cat?.nombre ?? "").trim().toUpperCase();
      const mapeo = CATEGORIAS_LOBBY[nombre];
      if (!mapeo) {
        console.warn(`[lobbypms] categoría sin mapear: "${cat?.nombre}" — revisar CATEGORIAS_LOBBY`);
        continue;
      }
      resultado.push({
        nombreLobby: cat.nombre,
        clase: mapeo.clase,
        capacidad: mapeo.capacidad,
        disponibles: Number(cat?.rooms_count ?? 0),
      });
    }

    if (resultado.length === 0) {
      console.error("[lobbypms] el motor público no trajo ninguna categoría reconocible");
      return null;
    }
    return resultado;
  } catch (err) {
    console.error(`[lobbypms] el motor público tampoco respondió: ${resumirError(err)}`);
    return null;
  }
}

// --- Lo que consume el bot ------------------------------------------------------------------

/**
 * Cupo para una estadía. Intenta la API oficial y, si no se pudo, cae al motor público — así el
 * bot sigue pudiendo decirle al cliente si hay cupo aunque falte autorizar la IP o el token esté
 * rotado. Devuelve `null` solo si fallaron LAS DOS vías: ahí el bot vuelve al
 * "le confirmo con el equipo" de siempre.
 *
 * La firma no cambió respecto de la versión anterior, así que consultar_planes
 * (src/agentes/ventas/herramientas/planes.ts) la sigue usando igual.
 */
export async function consultarDisponibilidad(
  fechaEntradaISO: string,
  noches = 1
): Promise<DisponibilidadCategoria[] | null> {
  const porDia = await consultarDisponibilidadPorDia(fechaEntradaISO, noches);
  if (porDia && porDia.length > 0) return agregarPorRango(porDia, Math.max(1, noches));
  return consultarMotorPublico(fechaEntradaISO, noches);
}

/** Una fecha de entrada que sí tiene cupo, con las categorías que le quedan libres. */
export interface FechaAlternativa {
  fecha: string;
  categorias: DisponibilidadCategoria[];
}

/**
 * [2026-09-10] Fechas cercanas que SÍ tienen cupo, para cuando la que pidió el cliente no lo
 * tiene ("el 19 no me queda, pero el 20 y el 21 sí"). Lo necesita el agente de postventa y el
 * flujo de venta.
 *
 * Hace UNA sola consulta a la API oficial por todo el rango y después evalúa, para cada posible
 * fecha de entrada, si hay cupo en TODAS las noches de la estadía.
 *
 * Devuelve `null` si la API oficial no está disponible: el motor público no da detalle por día,
 * así que sin ella no se puede afirmar nada sobre otras fechas — y en ese caso el bot NO debe
 * inventar alternativas.
 */
export async function buscarFechasAlternativas(
  fechaBaseISO: string,
  noches = 1,
  diasAlrededor = 7
): Promise<FechaAlternativa[] | null> {
  const nochesReales = Math.max(1, noches);
  const dias = Math.max(1, diasAlrededor);

  // El rango tiene que cubrir la última fecha de entrada candidata MÁS sus noches. Con `end_date`
  // inclusivo, pedir `dias + nochesReales` "noches" devuelve exactamente hasta
  // `fechaBase + dias + nochesReales - 1`, que es la última noche de la última estadía candidata.
  const porDia = await consultarDisponibilidadPorDia(fechaBaseISO, dias + nochesReales);
  if (!porDia || porDia.length === 0) return null;

  const cupoPorFecha = new Map<string, DisponibilidadCategoria[]>();
  for (const dia of porDia) cupoPorFecha.set(dia.fecha, dia.categorias);

  const alternativas: FechaAlternativa[] = [];
  for (let i = 0; i <= dias; i++) {
    const entrada = sumarDias(fechaBaseISO, i);
    if (!entrada) continue;

    // Todas las noches de esta estadía candidata tienen que estar en la respuesta.
    const nochesDeLaEstadia: DisponibilidadDia[] = [];
    let completo = true;
    for (let n = 0; n < nochesReales; n++) {
      const fechaNoche = sumarDias(entrada, n);
      const categorias = fechaNoche ? cupoPorFecha.get(fechaNoche) : undefined;
      if (!categorias) {
        completo = false;
        break;
      }
      nochesDeLaEstadia.push({ fecha: fechaNoche!, categorias });
    }
    if (!completo) continue;

    const conCupo = agregarPorRango(nochesDeLaEstadia, nochesReales).filter((c) => c.disponibles > 0);
    if (conCupo.length > 0) alternativas.push({ fecha: entrada, categorias: conCupo });
  }

  return alternativas;
}

// --- Camino 3: bloqueo real de cupo y creación de reservas (2026-09-10) --------------------
//
// [2026-09-10] Completa 1.2.c/1.2.d: hasta acá el archivo solo LEE disponibilidad. Lo de abajo
// SÍ modifica cosas en LobbyPMS (bloquea cupo, crea clientes, crea reservas) — el contrato de
// "nunca lanza, devolvé null/false si algo no se pudo" se mantiene igual que en todo el archivo,
// porque quien llama (registrar_datos_reserva, /confirmar) tiene que poder seguir funcionando
// con el candado interno de siempre si la API oficial no responde.
//
// Referencia completa de estos endpoints (documentación real, leída el 2026-09-10):
// ver REFERENCIA-API-LOBBYPMS.md en la raíz del proyecto.

function apiDisponibleOAvisar(operacion: string): boolean {
  if (!API_TOKEN) {
    console.warn(`[lobbypms] ${operacion}: sin LOBBYPMS_API_TOKEN configurado, no se puede hacer.`);
    return false;
  }
  return true;
}

/**
 * Category_id real de LobbyPMS para una clase+capacidad del bot, resuelto en caliente contra la
 * disponibilidad (GET /available-rooms) en vez de guardarlo hardcodeado en una tabla: si
 * LobbyPMS cambia sus category_id, esto se autocorrige solo. `null` si la API oficial no está
 * disponible o si esa combinación no aparece para esa fecha.
 */
export async function resolverCategoryId(
  clase: ClaseDomoBot,
  capacidad: number,
  fechaEntradaISO: string,
  noches = 1
): Promise<number | null> {
  const porDia = await consultarDisponibilidadPorDia(fechaEntradaISO, noches);
  if (!porDia || porDia.length === 0) return null;
  const agregadas = agregarPorRango(porDia, Math.max(1, noches));
  const encontrada = agregadas.find((c) => c.clase === clase && c.capacidad === capacidad && c.categoryId != null);
  return encontrada?.categoryId ?? null;
}

export interface NuevoBlockLobby {
  categoryId: number;
  fechaEntradaISO: string;
  /**
   * [2026-09-11] La ÚLTIMA NOCHE del bloqueo, no el día de salida — `end_date` es inclusivo,
   * igual que en `available-rooms` (ver la nota larga en consultarDisponibilidadPorDia). Para
   * una noche: la misma fecha de entrada.
   *
   * Antes acá se mandaba la fecha de salida (entrada + 1) y cada bloqueo de 10 minutos apartaba
   * DOS noches en vez de una: en el calendario de LobbyPMS se veía "Blo..." en las dos celdas.
   */
  fechaUltimaNocheISO: string;
  /** Minutos que dura el bloqueo. Si no se manda, LobbyPMS lo deja en 60 (su valor por defecto). */
  minutos: number;
  nota?: string;
}

export interface BlockLobby {
  blockId: number;
}

/**
 * POST /api/v1/block — el bloqueo REAL de cupo (visible en el calendario de los vendedores, a
 * diferencia del candado interno de `bloqueos_temporales`). Se usa desde
 * `registrar_datos_reserva` apenas el cliente da sus datos.
 */
export async function crearBlockLobby(datos: NuevoBlockLobby): Promise<BlockLobby | null> {
  if (!apiDisponibleOAvisar("crear el bloqueo real de cupo")) return null;
  try {
    const res = await axios.post(
      `${API_OFICIAL_URL}/block`,
      {
        api_token: API_TOKEN,
        category_id: datos.categoryId,
        start_date: datos.fechaEntradaISO,
        end_date: datos.fechaUltimaNocheISO,
        number_rooms: 1,
        time: datos.minutos,
        note: datos.nota ?? "Bloqueo del bot de WhatsApp — pendiente de pago",
      },
      { timeout: TIMEOUT_MS, headers: { Accept: "application/json" } }
    );
    const blockId = res.data?.blocked_ids?.[0] ?? res.data?.rooms?.[0]?.block_id;
    if (blockId == null) {
      console.error(
        "[lobbypms] POST /block respondió sin block_id reconocible:",
        JSON.stringify(res.data).slice(0, 300)
      );
      return null;
    }
    console.log(
      `[lobbypms] Bloqueo real creado en LobbyPMS: block_id=${blockId} (categoría ${datos.categoryId}, ${datos.minutos} min).`
    );
    return { blockId: Number(blockId) };
  } catch (err) {
    console.error(`[lobbypms] no se pudo crear el bloqueo real (POST /block): ${resumirError(err)}`);
    return null;
  }
}

/** DELETE /api/v1/block/{block_id} — libera el bloqueo real antes de que expire (el cliente ya
 * confirmó y se creó la reserva, o el bot se lo liberó por vencimiento). */
export async function liberarBlockLobby(blockId: number): Promise<boolean> {
  if (!apiDisponibleOAvisar("liberar el bloqueo real de cupo")) return false;
  try {
    const res = await axios.delete(`${API_OFICIAL_URL}/block/${blockId}`, {
      params: { api_token: API_TOKEN },
      timeout: TIMEOUT_MS,
      headers: { Accept: "application/json" },
    });
    const ok = res.data?.delete_block === true;
    if (!ok) {
      console.warn(
        `[lobbypms] DELETE /block/${blockId} no confirmó la liberación:`,
        JSON.stringify(res.data).slice(0, 200)
      );
    } else {
      console.log(`[lobbypms] Bloqueo real liberado en LobbyPMS: block_id=${blockId}.`);
    }
    return ok;
  } catch (err) {
    console.error(`[lobbypms] no se pudo liberar el bloqueo real block_id=${blockId} (DELETE /block): ${resumirError(err)}`);
    return false;
  }
}

/**
 * LobbyPMS espera el celular con código de país (ej. "+573001245678"). Lo que guarda el bot es
 * casi siempre un celular colombiano de 10 dígitos sin el +57 — si viene así, se le agrega; si
 * ya trae algo distinto (otro país, o ya con "+"), se manda tal cual y que LobbyPMS decida.
 */
function formatoTelefonoLobby(celular: string): string {
  const soloDigitos = celular.replace(/[^\d]/g, "");
  if (/^\d{10}$/.test(soloDigitos)) return `+57${soloDigitos}`;
  return celular.startsWith("+") ? celular : `+${soloDigitos || celular}`;
}

/** Mapeo del tipo de documento del bot al id fijo que espera LobbyPMS (GET /api/v1/documents):
 * 1 Tarjeta de identidad, 2 Cédula de ciudadanía, 3 Pasaporte, 4 Cédula de extranjería, 5 DNI,
 * 6 NIT. `undefined` si no se reconoce — LobbyPMS lo deja simplemente sin ese dato opcional. */
function documentIdLobby(tipoDocumentoTexto: string): number | undefined {
  const t = tipoDocumentoTexto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/pasaporte|passport/.test(t)) return 3;
  if (/extranjer/.test(t)) return 4;
  if (/tarjeta de identidad|^ti$/.test(t)) return 1;
  if (/\bnit\b/.test(t)) return 6;
  if (/\bdni\b/.test(t)) return 5;
  if (/cedula|\bcc\b|ciudadania|documento/.test(t)) return 2;
  return undefined;
}

export interface ClienteLobby {
  nombreCompleto: string;
  tipoDocumentoTexto: string;
  numeroDocumento: string;
  celular?: string | null;
  correo?: string | null;
  /** Código ISO 3166-1. La Julita hoy no le pregunta la nacionalidad al cliente porque casi
   * todos son de Colombia — si algún día hace falta distinguir huéspedes extranjeros, este es
   * el lugar para empezar a pedirlo. */
  nacionalidad?: string;
}

/**
 * POST /api/v1/customer/1 (persona) — crea o actualiza (si el documento ya existe en la
 * propiedad) el cliente en LobbyPMS ANTES de crear la reserva a su nombre. Se llama desde
 * `/confirmar` (ver src/core/pipeline/reservaLobby.ts), nunca desde el bot mientras el cliente
 * todavía no pagó, para no dejar "clientes fantasma" en LobbyPMS por reservas que nunca se
 * concretaron.
 */
export async function crearOActualizarClienteLobby(datos: ClienteLobby): Promise<boolean> {
  if (!apiDisponibleOAvisar("crear/actualizar el cliente en LobbyPMS")) return false;
  const partes = datos.nombreCompleto.trim().split(/\s+/).filter(Boolean);
  const nombre = partes[0] ?? datos.nombreCompleto;
  const apellido = partes.slice(1).join(" ") || nombre; // la API exige surname; sin apellido, se repite el nombre.
  try {
    const res = await axios.post(
      `${API_OFICIAL_URL}/customer/1`,
      {
        api_token: API_TOKEN,
        customer_document: datos.numeroDocumento,
        customer_nationality: datos.nacionalidad ?? "CO",
        name: nombre,
        surname: apellido,
        document_id: documentIdLobby(datos.tipoDocumentoTexto),
        phone: datos.celular ? formatoTelefonoLobby(datos.celular) : undefined,
        email: datos.correo || undefined,
      },
      { timeout: TIMEOUT_MS, headers: { Accept: "application/json" } }
    );
    console.log(`[lobbypms] Cliente en LobbyPMS listo (documento ${datos.numeroDocumento}): HTTP ${res.status}.`);
    return true;
  } catch (err) {
    console.warn(
      `[lobbypms] no se pudo crear/actualizar el cliente en LobbyPMS, sigo con holder_name como respaldo: ${resumirError(err)}`
    );
    return false;
  }
}

export interface NuevaReservaLobby {
  categoryId: number;
  fechaEntradaISO: string;
  fechaSalidaISO: string;
  totalAdultos: number;
  totalNinos?: number;
  /** Si ya se creó/actualizó el cliente en LobbyPMS (crearOActualizarClienteLobby), su
   * documento — así LobbyPMS vincula la reserva a ese cliente. */
  numeroDocumentoCliente?: string;
  nacionalidadCliente?: string;
  /** Respaldo si no se pudo crear el cliente antes: LobbyPMS crea uno nuevo solo con el nombre. */
  nombreSiNuevo?: string;
  /** El anticipo ya cobrado (o por cobrar) — nuestro 50% de siempre. */
  anticipo?: number;
  nota?: string;
  /** Id del canal de venta (GET /api/v1/channels) para distinguir en LobbyPMS lo que entra por
   * el bot — opcional, ver LOBBYPMS_CHANNEL_ID en el .env. */
  channelId?: number;
}

export interface ReservaLobby {
  bookingId: number;
  roomId: number | null;
}

/** POST /api/v1/bookings — crea la reserva real. Es el paso final de 1.2.d, llamado desde
 * /confirmar cuando el equipo ya verificó el pago (ver src/core/pipeline/reservaLobby.ts). */
export async function crearReservaLobby(datos: NuevaReservaLobby): Promise<ReservaLobby | null> {
  if (!apiDisponibleOAvisar("crear la reserva real")) return null;

  const cuerpo: Record<string, unknown> = {
    api_token: API_TOKEN,
    category_id: datos.categoryId,
    start_date: datos.fechaEntradaISO,
    end_date: datos.fechaSalidaISO,
    total_adults: datos.totalAdultos,
  };
  if (datos.totalNinos) cuerpo.total_children = datos.totalNinos;
  if (datos.numeroDocumentoCliente) {
    cuerpo.customer_document = datos.numeroDocumentoCliente;
    cuerpo.customer_nationality = datos.nacionalidadCliente ?? "CO";
  } else if (datos.nombreSiNuevo) {
    cuerpo.holder_name = datos.nombreSiNuevo;
  }
  if (datos.anticipo != null) cuerpo.payment = datos.anticipo;
  if (datos.nota) cuerpo.note = datos.nota;
  if (datos.channelId != null) cuerpo.channel = datos.channelId;

  try {
    const res = await axios.post(`${API_OFICIAL_URL}/bookings`, cuerpo, {
      timeout: TIMEOUT_MS,
      headers: { Accept: "application/json" },
    });
    const fila = res.data?.data?.[0];
    const bookingId = fila?.idBooking;
    if (bookingId == null) {
      console.error(
        "[lobbypms] POST /bookings respondió sin idBooking reconocible:",
        JSON.stringify(res.data).slice(0, 300)
      );
      return null;
    }
    console.log(`[lobbypms] Reserva real creada en LobbyPMS: booking_id=${bookingId} (categoría ${datos.categoryId}).`);
    return { bookingId: Number(bookingId), roomId: fila?.idRoom != null ? Number(fila.idRoom) : null };
  } catch (err) {
    console.error(`[lobbypms] no se pudo crear la reserva real (POST /bookings): ${resumirError(err)}`);
    return null;
  }
}
