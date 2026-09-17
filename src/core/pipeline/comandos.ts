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
 * [2026-09-17] REPORTES DE FALLAS: un texto o un audio (ya transcrito en runTurn.ts) que empiece
 * con la palabra "corrige" — SIN barra: "/corrige" es enseñar una regla, "corrige ..." es contar
 * algo que salió mal — se guarda tal cual como un ticket abierto en la tabla `tickets` del
 * panel, con quién lo reportó y por qué medio llegó. No se deduplica (ver abrirTicketReportado).
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
  // "Corrige", "corrige:", "Corrige, ..." — la transcripción del audio suele meter puntuación.
  const m = /^corrige\b[\s:,.\-–—]*/i.exec(limpio);
  if (!m) return { manejado: false };

  const quien = await puedeReportar(canal, externalId);
  if (!quien) return { manejado: false };

  const detalle = limpio.slice(m[0].length).trim();
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
  const limpio = (texto ?? "").trim();
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

  // --- 3. Reporte de falla: "corrige ..." sin barra (ver intentarReporteDeFalla) ---
  if (!limpio.startsWith("/")) {
    return await intentarReporteDeFalla(canal, externalId, limpio, medio);
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
  ].includes(comando);
  if (!conocido) return { manejado: false };

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
