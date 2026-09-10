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
 * `end_date` es el día de SALIDA y no viene incluido en la respuesta (rango [entrada, salida)),
 * igual que se cuentan las noches: 1 noche = entrada + 1 día.
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

  const fechaSalidaISO = sumarDias(fechaEntradaISO, Math.max(1, noches));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaEntradaISO) || !fechaSalidaISO) {
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
          end_date: fechaSalidaISO,
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

  // El rango tiene que cubrir la última fecha de entrada candidata MÁS sus noches.
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
