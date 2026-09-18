import crypto from "node:crypto";
import { agregarCorreccion, desactivarCorreccion, listCorrecciones } from "../db/correccionesRepo.js";
import { crearSesion, usuarioDeSesion, cerrarSesion } from "../db/sesionesRepo.js";
import { bloqueosPendientes, confirmarBloqueo } from "../db/bloqueosRepo.js";
import { cancelarLiberacion } from "../queue/bloqueoQueue.js";
import { resolverEscalamiento, conversacionesEscaladas } from "../db/estadoRepo.js";
import { crearReservaRealDesdeBloqueo } from "./reservaLobby.js";
// [2026-09-17] Reportes de fallas ("corrige ...") y historial de enseñanzas (/aprende) → tabla
// `tickets` del panel. Quién puede hacerlo se marca en la tabla `users` del panel
// (sql/users-bot-corrige.sql); el .env queda como respaldo.
import { abrirTicketReportado, abrirTicketEnsenanza } from "../db/ticketsRepo.js";
import { permisosDeNumero } from "../db/usuariosPanelRepo.js";
// [2026-09-17] /reset — dejar el propio número como cliente nuevo para volver a probar.
import { borrarConversacion, totalDe } from "../db/resetRepo.js";
import { drainInboundBuffer } from "../queue/inboundQueue.js";
import { cancelarRecontacto } from "../queue/recontactoQueue.js";

/**
 * Comandos del equipo por el mismo WhatsApp del bot: sirven para enseñarle cosas en caliente
 * ("no digas cabañas, decí domos") y que aplique con todos los clientes desde el mensaje
 * siguiente.
 *
 * IDENTIFICACIÓN (lo delicado de este archivo)
 * --------------------------------------------
 * Hay dos formas de que el bot te reconozca:
 *   1. Que tu número esté en OWNER_WHATSAPP_NUMBERS (atajo, sin clave).
 *   2. Identificándote desde CUALQUIER número: mandás el código secreto (TEAM_SECRET_CODE), el
 *      bot te pide usuario y clave, y si son correctas tu número queda habilitado unas horas
 *      (TEAM_SESSION_HOURS).
 *
 * Cuidados que NO son opcionales, porque una clave escrita en WhatsApp queda en el chat del
 * teléfono, en la base de mensajes y en cualquier log:
 *   - el mensaje con la clave NO se guarda en `mensajes` ni entra al historial del modelo
 *     (estos comandos se atienden antes de todo eso, ver runTurn.ts);
 *   - nunca se escribe la clave en los logs: solo queda el número y si acertó o no;
 *   - el bot le pide al usuario que borre el mensaje después de identificarse;
 *   - hay límite de intentos por número, para que nadie adivine la clave a fuerza de mensajes;
 *   - las claves se pueden guardar hasheadas en el .env (sha256), así el archivo no las tiene
 *     en texto plano.
 */

const COMANDOS_CORRECCION = ["/corrige", "/corregir", "/aprende"];
const COMANDOS_LISTAR = ["/correcciones", "/aprendido"];
const COMANDOS_BORRAR = ["/borra", "/borrar", "/olvida"];
const COMANDOS_AYUDA = ["/ayuda", "/comandos"];
const COMANDOS_LOGIN = ["/soy", "/login"];
const COMANDOS_SALIR = ["/salir", "/logout"];
const COMANDOS_CONFIRMAR = ["/confirmar", "/confirmo"];
const COMANDOS_RESUELTO = ["/resuelto", "/reanudar"];
const COMANDOS_RESET = ["/reset", "/reiniciar"];

const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const ESPERA_CREDENCIALES_MS = 5 * 60 * 1000;

/** Números que quedaron esperando usuario y clave tras mandar el código secreto. */
const esperandoCredenciales = new Map<string, number>();
/** Intentos fallidos por número, para frenar a quien pruebe claves a lo bruto. */
const intentosFallidos = new Map<string, { cuenta: number; hasta: number }>();

function clave(numero: string): string {
  return numero.replace(/\D/g, "").slice(-10);
}

function sha256(texto: string): string {
  return crypto.createHash("sha256").update(texto, "utf8").digest("hex");
}

export function numerosAutorizados(): string[] {
  return (process.env.OWNER_WHATSAPP_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

export function esNumeroAutorizado(externalId: string): boolean {
  const autorizados = numerosAutorizados();
  if (autorizados.length === 0) return false;
  const k = clave(externalId);
  return k.length > 0 && autorizados.some((n) => clave(n) === k);
}

/** Usuarios del equipo: "usuario:clave" o "usuario:<sha256>" separados por coma. */
function usuariosConfigurados(): { usuario: string; secreto: string }[] {
  return (process.env.TEAM_LOGIN_USERS ?? "")
    .split(",")
    .map((par) => par.trim())
    .filter((par) => par.includes(":"))
    .map((par) => {
      const i = par.indexOf(":");
      return { usuario: par.slice(0, i).trim().toLowerCase(), secreto: par.slice(i + 1).trim() };
    })
    .filter((u) => u.usuario.length > 0 && u.secreto.length > 0);
}

/** Compara sin filtrar por tiempo de respuesta; acepta clave en texto plano o hash sha256. */
function claveCorrecta(secretoGuardado: string, claveRecibida: string): boolean {
  const esperado = /^[a-f0-9]{64}$/i.test(secretoGuardado) ? secretoGuardado.toLowerCase() : sha256(secretoGuardado);
  const recibido = sha256(claveRecibida);
  const a = Buffer.from(esperado, "utf8");
  const b = Buffer.from(recibido, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bloqueado(externalId: string): boolean {
  const registro = intentosFallidos.get(clave(externalId));
  return Boolean(registro && registro.hasta > Date.now());
}

function anotarFallo(externalId: string): void {
  const k = clave(externalId);
  const registro = intentosFallidos.get(k) ?? { cuenta: 0, hasta: 0 };
  registro.cuenta++;
  if (registro.cuenta >= MAX_INTENTOS) {
    registro.hasta = Date.now() + BLOQUEO_MS;
    registro.cuenta = 0;
  }
  intentosFallidos.set(k, registro);
}

function limpiarFallos(externalId: string): void {
  intentosFallidos.delete(clave(externalId));
}

export interface ResultadoComando {
  /** true = ya se atendió como comando; el turno normal del bot no debe correr. */
  manejado: boolean;
  respuesta?: string;
  /** Qué escribir en los logs. Nunca incluye claves. */
  etiquetaParaLog?: string;
  /**
   * [2026-09-17] /reset: además de lo que se borró en la base, runTurn.ts tiene que olvidar sus
   * cachés en memoria de esta conversación (`historyByUser`, `ultimosArgsDePlanes`). Se pide así,
   * con una bandera, y no importando runTurn desde acá, porque runTurn YA importa este archivo:
   * los Maps son suyos y él es quien los limpia.
   */
  olvidarMemoria?: boolean;
}

/**
 * [2026-09-17] Números de REPORTE_FALLAS_NUMBERS: solo pueden reportar fallas ("corrige ..."),
 * no enseñar reglas. Es una lista aparte de OWNER_WHATSAPP_NUMBERS (ver .env.example).
 */
export function numerosDeReporte(): string[] {
  return (process.env.REPORTE_FALLAS_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

function esNumeroDeReporte(externalId: string): boolean {
  const k = clave(externalId);
  return k.length > 0 && numerosDeReporte().some((n) => clave(n) === k);
}

/**
 * ¿Este número puede darle órdenes al bot ahora mismo? Devuelve cómo se lo reconoció (para los
 * logs y para firmar los tickets), o null.
 *
 * [2026-09-17] Orden: primero el .env (no cuesta nada), después la tabla `users` del panel —
 * usuarios activos con "puede corregir el bot" y su celular (sql/users-bot-corrige.sql), con
 * caché de un minuto — y por último la sesión abierta con el código secreto.
 */
export async function puedeCorregir(canal: string, externalId: string): Promise<string | null> {
  if (esNumeroAutorizado(externalId)) return "número autorizado";
  const panel = await permisosDeNumero(externalId);
  if (panel?.puedeEnsenar) return panel.nombre;
  return await usuarioDeSesion(canal, externalId);
}

/** ¿Este número puede REPORTAR fallas? Todo el que puede corregir, más REPORTE_FALLAS_NUMBERS. */
async function puedeReportar(canal: string, externalId: string): Promise<string | null> {
  const quien = await puedeCorregir(canal, externalId);
  if (quien) return quien;
  return esNumeroDeReporte(externalId) ? "número de reportes" : null;
}

export type MedioDeMensaje = "texto" | "audio";

/**
 * [2026-09-17] Formas de empezar un reporte de falla. Antes solo valía "corrige" exacto, y se
 * perdían en silencio los reportes escritos como "corrígelo" (con tilde), "corregir" o con los
 * errores de tipeo de siempre — y sobre todo los AUDIOS, porque la transcripción devuelve la
 * palabra bien acentuada ("corrígeme que...") y así nunca coincidía.
 *
 * Todas son del verbo corregir a propósito: son órdenes, no algo que alguien escriba de paso.
 * Para sumar otra, agregala acá; el orden no importa (el `\b` del patrón impide que "corrige"
 * se coma el principio de "corrígelo").
 */
const VERBOS_REPORTE = [
  "corrige",
  "corrigeme",
  "corrigelo",
  "corrigela",
  "corrigan",
  "corriganlo",
  "corriganla",
  "corriganme",
  "corrijan",
  "corrijanlo",
  "corrijanla",
  "corrijanme",
  "corrija",
  "corrijame",
  "corrijalo",
  "corrijala",
  "corregir",
  "corregime",
  "corregilo",
  "corregi",
  // Errores de tipeo y transcripciones imperfectas que se ven seguido:
  "corrije",
  "correge",
  "corrigue",
  "corrigir",
];

/**
 * [2026-09-18] Formas de EMPEZAR una enseñanza sin barra: "aprende: ...", "aprendé que ...",
 * "aprender ...". Hasta hoy solo valía "/aprende" con barra, y eso le costó caro a Daniel: le
 * escribió al bot «aprende: por que le ofreces plan para una persona si en el chat el te pidio
 * plan para dos ? revisa y corrige.» y el bot, que no reconoció ninguna orden, lo trató como un
 * cliente cualquiera. El orquestador leyó un reclamo por un error del bot —que es justo lo que
 * era— lo mandó a `humano`, escaló la conversación y le contestó "Ya te comunico con el equipo de
 * La Julita". O sea: el dueño del bot le enseñó algo y el bot lo puso en la cola de soporte.
 *
 * Son solo del verbo aprender, igual que VERBOS_REPORTE es solo del verbo corregir: tienen que
 * ser órdenes inequívocas, no algo que alguien escriba de paso.
 */
const VERBOS_ENSENANZA = [
  "aprende",
  "aprendelo",
  "aprendela",
  "aprendete",
  "aprendeme",
  "aprender",
  "aprendan",
  "aprendanlo",
  "aprendanla",
  "aprenda",
  "aprendalo",
  "aprendase",
  "aprendi",
  "aprendiendo",
  // Errores de tipeo reales (Daniel escribe rápido desde el teléfono). Igual no hace falta
  // adivinarlos todos: lo que no esté acá lo agarra `seParecemA`, más abajo.
  "apreder",
  "aprede",
  "aprnde",
];

/**
 * [2026-09-18] Distancia de edición (Levenshtein) entre dos palabras. Es chiquita a propósito:
 * solo se usa para comparar UNA palabra contra dos listas cortas.
 */
function distancia(a: string, b: string): number {
  const fila = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let anterior = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = fila[j];
      fila[j] = Math.min(
        fila[j] + 1, // borrar
        fila[j - 1] + 1, // insertar
        anterior + (a[i - 1] === b[j - 1] ? 0 : 1) // sustituir
      );
      anterior = temp;
    }
  }
  return fila[b.length];
}

/**
 * [2026-09-18] ¿La primera palabra del mensaje QUISO ser uno de estos verbos?
 *
 * Por qué existe: el 2026-09-17 Daniel le enseñó una regla al bot y el bot no la tomó; hoy
 * volvió a intentarlo escribiendo "apreder: cambia ..." y tampoco. Las listas de verbos son
 * exactas, así que una letra de menos convierte una orden del equipo en un mensaje de cliente
 * cualquiera — y el bot contesta como si nada, que es lo peor: el equipo se queda creyendo que
 * le enseñó algo.
 *
 * Se tolera una letra de diferencia (dos si la palabra es larga), y solo se consulta cuando la
 * coincidencia exacta ya falló. El riesgo de un falso positivo es bajísimo: esto corre únicamente
 * sobre la PRIMERA palabra del mensaje y solo para números autorizados del equipo.
 */
function seParecemA(palabra: string, verbos: string[]): boolean {
  const p = palabra.toLowerCase().replace(/[^a-zñ]/g, "");
  if (p.length < 5) return false;
  const tolerancia = p.length >= 8 ? 2 : 1;
  return verbos.some((v) => Math.abs(v.length - p.length) <= tolerancia && distancia(p, v) <= tolerancia);
}

/**
 * Quita las tildes reemplazando carácter por carácter. Se hace así, y NO con `normalize("NFD")`,
 * porque la descomposición cambia el largo del texto: acá el resultado tiene que medir
 * exactamente lo mismo que el original para poder cortar el detalle del reporte con el índice
 * que devuelve el patrón (ver `intentarReporteDeFalla`).
 */
function sinTildes(texto: string): string {
  return texto
    .replace(/[áàäâã]/g, "a")
    .replace(/[ÁÀÄÂÃ]/g, "A")
    .replace(/[éèëê]/g, "e")
    .replace(/[ÉÈËÊ]/g, "E")
    .replace(/[íìïî]/g, "i")
    .replace(/[ÍÌÏÎ]/g, "I")
    .replace(/[óòöô]/g, "o")
    .replace(/[ÓÒÖÔ]/g, "O")
    .replace(/[úùüû]/g, "u")
    .replace(/[ÚÙÜÛ]/g, "U");
}

/** Signos con los que suele venir pegada la palabra, sobre todo en la transcripción de un audio. */
const RE_REPORTE = new RegExp(`^(?:${VERBOS_REPORTE.join("|")})\\b[\\s:,.\\-–—¡!¿?]*`, "i");
/** Mismo molde que RE_REPORTE, para las enseñanzas sin barra ("aprende: ...", "aprendé que ..."). */
const RE_ENSENANZA = new RegExp(`^(?:${VERBOS_ENSENANZA.join("|")})\\b[\\s:,.\\-–—¡!¿?]*`, "i");

/**
 * [2026-09-17] REPORTES DE FALLAS: un texto o un audio (ya transcrito en runTurn.ts) que empiece
 * con la palabra "corrige" o alguna de sus variantes (con tilde, en infinitivo o con los errores
 * de tipeo de siempre — ver VERBOS_REPORTE) — SIN barra: "/corrige" es enseñar una regla,
 * "corrige ..." es contar algo que salió mal — se guarda tal cual como un ticket abierto en la
 * tabla `tickets` del panel, con quién lo reportó y por qué medio llegó. No se deduplica (ver
 * abrirTicketReportado).
 *
 * Si el número no está autorizado, NO se contesta nada especial: se devuelve `manejado: false`
 * y el mensaje sigue como consulta normal de cliente (un cliente bien puede escribir "corrige
 * la fecha de mi reserva").
 */
export async function intentarReporteDeFalla(
  canal: string,
  externalId: string,
  texto: string,
  medio: MedioDeMensaje = "texto"
): Promise<ResultadoComando> {
  const limpio = (texto ?? "").trim();
  // "Corrige", "corrige:", "Corrige, ...", "Corrígelo", "corregir" — la transcripción del audio
  // mete tildes y puntuación, así que se busca sobre el texto sin tildes (ver sinTildes: mide
  // igual que el original) y el detalle se corta del original, que es el que se guarda.
  const m = RE_REPORTE.exec(sinTildes(limpio));
  // [2026-09-18] Igual que con las enseñanzas: si no coincidió exacto, se acepta que la primera
  // palabra haya querido ser "corrige" ("corrije", "corrigr"...). Ver seParecemA.
  const primeraPalabra = sinTildes(limpio).split(/[\s:,.\-–—¡!¿?]+/)[0] ?? "";
  const pareceReporte = !m && seParecemA(primeraPalabra, VERBOS_REPORTE);
  if (!m && !pareceReporte) return { manejado: false };

  const quien = await puedeReportar(canal, externalId);
  if (!quien) return { manejado: false };

  const detalle = limpio
    .slice(m ? m[0].length : primeraPalabra.length)
    .replace(/^[\s:,.\-–—¡!¿?]+/, "")
    .trim();
  if (detalle.length < 5) {
    return {
      manejado: true,
      etiquetaParaLog: `reporte de falla vacío (${quien}, ${medio})`,
      respuesta:
        "Contame qué salió mal después de la palabra corrige, así lo dejo anotado para el equipo. " +
        "Ejemplo: corrige el bot le dijo al cliente que había cupo el sábado y no había.",
    };
  }

  const ticketId = await abrirTicketReportado({ texto: detalle, reportadoPor: quien, canal, externalId, medio });
  if (ticketId == null) {
    return {
      manejado: true,
      etiquetaParaLog: `reporte de falla NO guardado (${quien}, ${medio})`,
      respuesta:
        "Te leí, pero no pude guardar el reporte en el panel — el detalle quedó en los logs del worker. " +
        "Por favor pasáselo directo al equipo técnico.",
    };
  }
  return {
    manejado: true,
    etiquetaParaLog: `reporte de falla #${ticketId} por ${quien} (${medio})`,
    respuesta:
      `Anotado ✅ Quedó como ticket #${ticketId} en el panel` +
      (medio === "audio" ? " (lo transcribí de tu audio)" : "") +
      `:\n\n"${detalle}"\n\nEl equipo técnico lo ve desde ya.`,
  };
}

async function intentarIdentificar(
  canal: string,
  externalId: string,
  usuario: string,
  claveRecibida: string
): Promise<ResultadoComando> {
  const configurados = usuariosConfigurados();
  if (configurados.length === 0) {
    return {
      manejado: true,
      etiquetaParaLog: "identificación imposible: TEAM_LOGIN_USERS vacío",
      respuesta:
        "Todavía no hay usuarios configurados para identificarse. Hay que definir TEAM_LOGIN_USERS en el .env.",
    };
  }

  const encontrado = configurados.find((u) => u.usuario === usuario.trim().toLowerCase());
  const ok = Boolean(encontrado && claveCorrecta(encontrado.secreto, claveRecibida));

  if (!ok) {
    anotarFallo(externalId);
    return {
      manejado: true,
      etiquetaParaLog: `identificación FALLIDA de ${externalId} (usuario "${usuario}")`,
      respuesta: "Usuario o clave incorrectos. Volvé a intentarlo mandando de nuevo el código secreto.",
    };
  }

  limpiarFallos(externalId);
  esperandoCredenciales.delete(clave(externalId));
  const horas = Number(process.env.TEAM_SESSION_HOURS ?? 8);
  const guardada = await crearSesion(canal, externalId, encontrado!.usuario, horas);

  if (!guardada) {
    return {
      manejado: true,
      etiquetaParaLog: `identificación OK de ${externalId} pero no se pudo guardar la sesión`,
      respuesta:
        "Te reconocí, pero no pude guardar la sesión — puede que falte crear la tabla " +
        "`sesiones_equipo` (sql/correcciones.sql). El detalle está en los logs.",
    };
  }

  return {
    manejado: true,
    etiquetaParaLog: `identificación OK de ${externalId} como "${encontrado!.usuario}"`,
    respuesta:
      `¡Hola ${encontrado!.usuario}! Quedaste identificado por ${horas} horas desde este número 🔐\n\n` +
      "🧹 Por seguridad, borrá el mensaje donde mandaste la clave: queda en el historial de este chat.\n\n" +
      "Ya podés enseñarme cosas:\n/corrige <lo que querés que cambie>\n/correcciones\n/borra <número>",
  };
}

export async function intentarComando(
  canal: string,
  externalId: string,
  texto: string,
  /** [2026-09-17] Cómo llegó el mensaje — queda en el ticket cuando es un reporte de falla. */
  medio: MedioDeMensaje = "texto"
): Promise<ResultadoComando> {
  let limpio = (texto ?? "").trim();
  if (!limpio) return { manejado: false };

  const codigoSecreto = (process.env.TEAM_SECRET_CODE ?? "").trim();
  const k = clave(externalId);

  // --- 1. ¿Está esperando que le manden usuario y clave? ---
  const esperaHasta = esperandoCredenciales.get(k);
  if (esperaHasta && esperaHasta > Date.now()) {
    if (bloqueado(externalId)) {
      esperandoCredenciales.delete(k);
      return {
        manejado: true,
        etiquetaParaLog: `identificación bloqueada por intentos fallidos (${externalId})`,
        respuesta: "Demasiados intentos fallidos. Esperá unos minutos antes de volver a intentarlo.",
      };
    }
    // El texto son las credenciales: "usuario clave" (o "usuario:clave"). NUNCA se loguea.
    const partes = limpio.split(/[\s:]+/).filter((p) => p.length > 0);
    if (partes.length < 2) {
      return {
        manejado: true,
        etiquetaParaLog: `credenciales incompletas de ${externalId}`,
        respuesta: "Mandame usuario y clave en un solo mensaje, separados por un espacio.",
      };
    }
    return await intentarIdentificar(canal, externalId, partes[0], partes.slice(1).join(" "));
  }
  if (esperaHasta) esperandoCredenciales.delete(k);

  // --- 2. ¿Es el código secreto? ---
  if (codigoSecreto && limpio.toLowerCase() === codigoSecreto.toLowerCase()) {
    if (bloqueado(externalId)) {
      return {
        manejado: true,
        etiquetaParaLog: `código secreto recibido de ${externalId} pero está bloqueado`,
        respuesta: "Demasiados intentos fallidos. Esperá unos minutos antes de volver a intentarlo.",
      };
    }
    esperandoCredenciales.set(k, Date.now() + ESPERA_CREDENCIALES_MS);
    return {
      manejado: true,
      etiquetaParaLog: `código secreto recibido de ${externalId}, esperando credenciales`,
      respuesta:
        "🔐 Identificate: mandame tu *usuario* y tu *clave* en un solo mensaje, separados por un espacio.\n\n" +
        "Tenés 5 minutos. Después de identificarte, borrá ese mensaje del chat.",
    };
  }

  // --- 3. Órdenes SIN barra ---
  //
  // Dos familias, y la diferencia importa: "aprende ..." es ENSEÑARLE una regla (se guarda en
  // `correcciones` y aplica con todos los clientes desde el mensaje siguiente), "corrige ..." es
  // REPORTAR algo que salió mal (queda como ticket para el equipo técnico). Con barra las dos ya
  // funcionaban; sin barra solo funcionaba la de reportes, y una enseñanza escrita sin barra
  // terminaba tratada como el mensaje de un cliente molesto — ver VERBOS_ENSENANZA.
  if (!limpio.startsWith("/")) {
    const ensenanza = RE_ENSENANZA.exec(sinTildes(limpio));
    // [2026-09-18] Si no coincidió exacto, se mira si la primera palabra QUISO ser uno de esos
    // verbos ("apreder" por "aprender"): ver seParecemA y el bug que lo motivó.
    const primeraPalabra = sinTildes(limpio).split(/[\s:,.\-–—¡!¿?]+/)[0] ?? "";
    const pareceEnsenanza = !ensenanza && seParecemA(primeraPalabra, VERBOS_ENSENANZA);

    if ((ensenanza || pareceEnsenanza) && (await puedeCorregir(canal, externalId))) {
      // Se reescribe como el comando equivalente y sigue por el camino de siempre: así hay UNA
      // sola implementación de "enseñar una regla", no dos que se puedan desincronizar.
      const largo = ensenanza ? ensenanza[0].length : primeraPalabra.length;
      const regla = limpio.slice(largo).replace(/^[\s:,.\-–—¡!¿?]+/, "").trim();
      if (pareceEnsenanza) {
        console.log(`[comandos] ${canal}:${externalId}: "${primeraPalabra}" se tomó como "aprende" (typo tolerado).`);
      }
      limpio = `/corrige ${regla}`;
    } else {
      return await intentarReporteDeFalla(canal, externalId, limpio, medio);
    }
  }

  // --- 4. Comandos con barra ---

  const espacio = limpio.indexOf(" ");
  const comando = (espacio === -1 ? limpio : limpio.slice(0, espacio)).toLowerCase();
  const resto = espacio === -1 ? "" : limpio.slice(espacio + 1).trim();

  const conocido = [
    ...COMANDOS_CORRECCION,
    ...COMANDOS_LISTAR,
    ...COMANDOS_BORRAR,
    ...COMANDOS_AYUDA,
    ...COMANDOS_LOGIN,
    ...COMANDOS_SALIR,
    ...COMANDOS_CONFIRMAR,
    ...COMANDOS_RESUELTO,
    ...COMANDOS_RESET,
  ].includes(comando);
  if (!conocido) {
    // [2026-09-18] Un comando que no existe, escrito por alguien del equipo, NO puede seguir de
    // largo como si fuera el mensaje de un cliente: el bot le contestaría con simpatía y la
    // persona se queda creyendo que le enseñó algo o que reportó algo. Le pasó a Daniel dos días
    // seguidos. A un cliente cualquiera que escriba un "/algo" sí se le sigue contestando normal.
    if (await puedeCorregir(canal, externalId)) {
      return {
        manejado: true,
        etiquetaParaLog: `comando desconocido "${comando}" de un número del equipo`,
        respuesta:
          `No conozco el comando *${comando}* 🤔 Los que sí:\n\n` +
          "• `/corrige <regla>` — te la aprendo y la aplico con todos los clientes (también vale *aprende ...* sin barra).\n" +
          "• `corrige <qué salió mal>` — SIN barra: queda como ticket para el equipo técnico.\n" +
          "• `/correcciones` — las que ya me enseñaste. `/borra <número>` para desactivar una.\n" +
          "• `/reset` — borro todo lo de este número para probar desde ceros.\n" +
          "• `/ayuda` — la lista completa.",
      };
    }
    return { manejado: false };
  }

  // Atajo: /soy usuario clave (mismo cuidado, no se loguea la clave)
  if (COMANDOS_LOGIN.includes(comando)) {
    if (bloqueado(externalId)) {
      return {
        manejado: true,
        etiquetaParaLog: `intento de /soy bloqueado (${externalId})`,
        respuesta: "Demasiados intentos fallidos. Esperá unos minutos antes de volver a intentarlo.",
      };
    }
    const partes = resto.split(/[\s:]+/).filter((p) => p.length > 0);
    if (partes.length < 2) {
      return {
        manejado: true,
        etiquetaParaLog: `/soy incompleto de ${externalId}`,
        respuesta: "Usalo así: /soy <usuario> <clave>",
      };
    }
    return await intentarIdentificar(canal, externalId, partes[0], partes.slice(1).join(" "));
  }

  const quien = await puedeCorregir(canal, externalId);

  if (COMANDOS_SALIR.includes(comando)) {
    if (!quien) return { manejado: false };
    await cerrarSesion(canal, externalId);
    return {
      manejado: true,
      etiquetaParaLog: `sesión cerrada (${externalId})`,
      respuesta: "Listo, cerré la sesión en este número 👋",
    };
  }

  if (!quien) {
    // Un cliente cualquiera no puede dar órdenes: se trata como mensaje normal y queda el aviso.
    console.warn(
      `[comandos] ${canal}:${externalId} intentó "${comando}" sin estar identificado — ` +
        "se trata como mensaje normal de cliente."
    );
    return { manejado: false };
  }

  if (COMANDOS_AYUDA.includes(comando)) {
    return {
      manejado: true,
      etiquetaParaLog: `/ayuda (${quien})`,
      respuesta:
        "Comandos del equipo 🛠️\n\n" +
        "/corrige <lo que querés que cambie> — se lo enseño y aplica con todos los clientes.\n" +
        "corrige <qué salió mal> (sin barra, texto o audio) — lo anoto como ticket para el equipo técnico.\n" +
        "/correcciones — te muestro todo lo aprendido, con su número.\n" +
        "/borra <número> — desactivo esa corrección.\n" +
        "/confirmar <número del cliente> — verificaste el pago: cancelo el bloqueo de 10 min, no le mando el aviso de liberación y creo la reserva real en LobbyPMS.\n" +
        "/resuelto <número del cliente> — ya atendiste el caso escalado: el bot vuelve a responderle normal desde su próximo mensaje.\n" +
        "/reset — borro TODO lo que tengo de tu número (historial, tus datos, reservas y pagos) para que pruebes desde ceros. Te muestro qué se va a borrar y borro recién con /reset confirmar.\n" +
        "/salir — cierro la sesión en este número.\n\n" +
        "Ejemplo: /corrige nunca digas cabañas, decí domos.",
    };
  }

  if (COMANDOS_CONFIRMAR.includes(comando)) {
    const numero = resto.replace(/\D/g, "").slice(-10);
    if (!numero) {
      return {
        manejado: true,
        etiquetaParaLog: `/confirmar sin número (${quien})`,
        respuesta: "Decime el número del cliente. Ejemplo: /confirmar 3001234567",
      };
    }
    // La tabla es chica y de vida corta (bloqueos vencen en minutos) — se trae todo lo
    // pendiente del canal y se compara por los últimos 10 dígitos, igual que con los números
    // del equipo (ver clave() arriba), para no depender de si el cliente lo escribió con +57.
    const pendientes = await bloqueosPendientes(canal);
    const delCliente = pendientes.find((b) => clave(b.external_id) === numero);
    if (!delCliente) {
      return {
        manejado: true,
        etiquetaParaLog: `/confirmar sin bloqueo pendiente para ${numero} (${quien})`,
        respuesta: `No encontré un bloqueo pendiente para ese número — puede que ya se haya vencido o que nunca haya tenido uno.`,
      };
    }
    const ok = await confirmarBloqueo(delCliente.id);
    if (!ok) {
      return {
        manejado: true,
        etiquetaParaLog: `/confirmar falló al guardar bloqueo #${delCliente.id} (${quien})`,
        respuesta: "No pude confirmar el bloqueo — el detalle quedó en los logs del worker.",
      };
    }
    await cancelarLiberacion(delCliente.id);

    // [2026-09-10] 1.2.d: con el pago ya verificado, el bot intenta crear la reserva REAL en
    // LobbyPMS (ver reservaLobby.ts) — mejor esfuerzo. El pago queda confirmado pase lo que
    // pase acá; si falla, se le avisa al equipo (nunca al cliente) para que la cree a mano.
    const resultadoLobby = await crearReservaRealDesdeBloqueo(delCliente);
    const avisoLobby = resultadoLobby.ok
      ? `\n\n✅ Reserva creada en LobbyPMS (#${resultadoLobby.bookingId}).`
      : `\n\n⚠️ No pude crearla sola en LobbyPMS (${resultadoLobby.motivo}) — hace falta crearla a mano en el panel.`;

    return {
      manejado: true,
      etiquetaParaLog:
        `/confirmar bloqueo #${delCliente.id} (cliente ${numero}) por ${quien} — LobbyPMS: ` +
        (resultadoLobby.ok ? `reserva #${resultadoLobby.bookingId}` : `falló (${resultadoLobby.motivo})`),
      respuesta:
        `Listo ✅ Confirmé el pago del bloqueo #${delCliente.id} — ya no se libera y no le mando el aviso de vencimiento.` +
        avisoLobby,
    };
  }

  // [2026-09-10] Cierra un escalamiento a humano (ver src/core/pipeline/runTurn.ts y
  // notificarEquipo.ts): el equipo ya atendió al cliente por su cuenta, así que se limpia
  // `escalado_en` y se resetea `last_agent` para que el bot vuelva a responderle normal
  // desde el próximo mensaje del cliente — si no, se quedaría "pegado" a humano para siempre.
  if (COMANDOS_RESUELTO.includes(comando)) {
    const numero = resto.replace(/\D/g, "").slice(-10);
    if (!numero) {
      return {
        manejado: true,
        etiquetaParaLog: `/resuelto sin número (${quien})`,
        respuesta: "Decime el número del cliente. Ejemplo: /resuelto 3001234567",
      };
    }
    const escaladas = await conversacionesEscaladas(canal);
    const delCliente = escaladas.find((c) => clave(c.external_id) === numero);
    if (!delCliente) {
      return {
        manejado: true,
        etiquetaParaLog: `/resuelto sin escalamiento pendiente para ${numero} (${quien})`,
        respuesta: "No encontré ese número como escalado ahora mismo — puede que ya lo hayas resuelto antes.",
      };
    }
    const ok = await resolverEscalamiento(canal, delCliente.external_id);
    return {
      manejado: true,
      etiquetaParaLog: `/resuelto (cliente ${numero}) por ${quien}: ${ok ? "ok" : "falló"}`,
      respuesta: ok
        ? `Listo ✅ El bot vuelve a atender a ese cliente normal desde su próximo mensaje.`
        : "No pude actualizarlo — el detalle quedó en los logs del worker.",
    };
  }

  /**
   * [2026-09-17] /reset — dejar ESTE número como si nunca hubiera escrito, para poder probar el
   * bot una y otra vez desde el mismo teléfono (pedido de Daniel). Borra el historial, el estado
   * de la conversación, los bloqueos de cupo y también el cliente con sus reservas, pagos y
   * acompañantes: si la fila de `clientes` sobrevive, el bot te vuelve a saludar por tu nombre y
   * la prueba no arranca limpia.
   *
   * [2026-09-17, mismo día] Borra DE UNA. La primera versión iba en dos pasos (`/reset` mostraba
   * la lista de lo que había y esperaba un `/reset confirmar`), copiando el molde de
   * sql/limpiar-pruebas-numero.sql. Daniel lo sacó al usarlo: el comando existe para probar el
   * bot muchas veces seguidas desde el mismo teléfono, y en ese uso la confirmación no protege
   * de nada — solo duplica los mensajes en cada vuelta. El riesgo real ya está acotado por el
   * alcance del comando, no por la confirmación: actúa SIEMPRE sobre el número de quien escribe
   * y no acepta un número ajeno, así que no existe la forma de borrarle los datos a un cliente
   * de verdad con un toque mal dado.
   *
   * Tampoco se muestra el resumen de lo borrado, por el mismo pedido. Lo que sí queda es la
   * cuenta en el log del worker, para poder revisar después qué se llevó cada reset.
   */
  if (COMANDOS_RESET.includes(comando)) {
    const { borrado, errores } = await borrarConversacion(canal, externalId);
    // El buffer de Redis puede tener mensajes de esta conversación esperando el debounce: si no
    // se vacía, el bot los procesaría después del reset como si fueran de la charla vieja.
    //
    // Con límite de tiempo a propósito: la conexión compartida usa `maxRetriesPerRequest: null`
    // (lo exige BullMQ, ver core/queue/redis.ts), así que un comando lanzado con Redis caído NO
    // falla — espera para siempre. Sin este tope, un /reset con Redis abajo borraría todo y
    // después se colgaría sin contestarle nada a quien lo pidió. Vaciar el buffer es lo menos
    // importante de todo el reset, así que si no se puede en 3 segundos, se sigue igual.
    //
    // [2026-09-17] El recontacto pendiente se cancela por la misma razón, y es el que de verdad
    // se hizo notar: Daniel hizo /reset a las 4:07 y un minuto después le llegó "¡Hola! ¿Cómo
    // estás? ¿Te cuento los planes...?" sin haber escrito nada. Era el paso 1 de la cadena de
    // recontactos, programado 20 minutos antes por la charla vieja. Sobrevivía al reset porque
    // vive en Redis y no en la base, y su chequeo de "¿el cliente ya contestó?" mira el
    // historial — que el reset acababa de dejar vacío, o sea que daba que no. Encima ese mensaje
    // quedaba siendo el PRIMERO de la conversación nueva, saltándose el saludo oficial con el
    // aviso de la política de datos.
    try {
      await Promise.race([
        Promise.all([drainInboundBuffer(canal, externalId), cancelarRecontacto(canal, externalId)]),
        new Promise((_, rechazar) => setTimeout(() => rechazar(new Error("Redis no respondió en 3s")), 3000)),
      ]);
    } catch (e) {
      console.error("[comandos] /reset limpiando lo que vive en Redis:", e instanceof Error ? e.message : e);
    }

    // Un fallo parcial SÍ se avisa: no es el resumen que Daniel pidió sacar, es la diferencia
    // entre creer que arrancás de cero y arrancar con datos viejos que van a ensuciar la prueba.
    if (errores.length > 0) {
      return {
        manejado: true,
        // La memoria se limpia igual: en la base ya se borró parte, seguir recordando la charla
        // vieja sería lo peor de los dos mundos.
        olvidarMemoria: true,
        etiquetaParaLog: `/reset PARCIAL por ${quien}: ${errores.join(" | ")}`,
        respuesta:
          `⚠️ Borré parte, pero no pude con: ${errores.join(", ")}.\n\n` +
          "El detalle está en los logs del worker. Para terminar de limpiarlo está `sql/limpiar-pruebas-numero.sql`.",
      };
    }

    return {
      manejado: true,
      olvidarMemoria: true,
      etiquetaParaLog: `/reset OK por ${quien} (${totalDe(borrado)} filas)`,
      respuesta: "Listo ✅ Borré todo lo de este número. Desde tu próximo mensaje te atiendo como un cliente nuevo.",
    };
  }

  if (COMANDOS_CORRECCION.includes(comando)) {
    if (resto.length < 5) {
      return {
        manejado: true,
        etiquetaParaLog: `/corrige vacío (${quien})`,
        respuesta: "Escribime qué corregir después del comando. Ejemplo:\n/corrige nunca digas cabañas, decí domos.",
      };
    }
    const guardada = await agregarCorreccion(resto, externalId, canal);
    if (!guardada) {
      return {
        manejado: true,
        etiquetaParaLog: `/corrige falló al guardar (${quien})`,
        respuesta:
          "No pude guardar la corrección — puede que falte crear la tabla `correcciones` " +
          "(sql/correcciones.sql). El detalle quedó en los logs del worker.",
      };
    }
    // [2026-09-17] Historial en el panel: la enseñanza nace como ticket ya RESUELTO (ver
    // abrirTicketEnsenanza). Mejor esfuerzo: la corrección YA quedó guardada pase lo que pase.
    const ticketId =
      guardada.id != null
        ? await abrirTicketEnsenanza({
            texto: resto,
            correccionId: guardada.id,
            ensenadoPor: quien,
            canal,
            externalId,
          })
        : null;
    const activas = await listCorrecciones(true);
    return {
      manejado: true,
      etiquetaParaLog: `/corrige #${guardada.id} por ${quien}` + (ticketId ? ` (ticket #${ticketId})` : " (sin ticket)"),
      respuesta:
        `Listo, aprendido ✅ (#${guardada.id})\n\n"${resto}"\n\n` +
        `Lo aplico desde el próximo mensaje, con todos los clientes. Van ${activas.length} correcciones activas.`,
    };
  }

  if (COMANDOS_LISTAR.includes(comando)) {
    const activas = await listCorrecciones(true);
    if (activas.length === 0) {
      return {
        manejado: true,
        etiquetaParaLog: `/correcciones (vacío) por ${quien}`,
        respuesta: "Todavía no me han enseñado nada. Usá /corrige para la primera.",
      };
    }
    const lista = activas
      .slice()
      .reverse()
      .map((c) => `#${c.id} — ${c.texto}`)
      .join("\n");
    return {
      manejado: true,
      etiquetaParaLog: `/correcciones (${activas.length}) por ${quien}`,
      respuesta: `Esto es lo que me enseñaron (${activas.length}):\n\n${lista}\n\nPara quitar una: /borra <número>`,
    };
  }

  const id = Number(resto.replace(/\D/g, ""));
  if (!id) {
    return {
      manejado: true,
      etiquetaParaLog: `/borra sin id por ${quien}`,
      respuesta: "Decime el número de la corrección. Ejemplo: /borra 3 (los ves con /correcciones).",
    };
  }
  const listo = await desactivarCorreccion(id);
  return {
    manejado: true,
    etiquetaParaLog: `/borra #${id} por ${quien} (${listo ? "ok" : "falló"})`,
    respuesta: listo
      ? `Hecho, ya no aplico la corrección #${id}.`
      : `No pude quitar la corrección #${id} — revisá el número con /correcciones.`,
  };
}
