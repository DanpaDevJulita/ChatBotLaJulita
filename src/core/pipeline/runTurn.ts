import type { ChannelAdapter, InboundEvent } from "../../channels/types.js";
import { LIMITE_CAPTION_WHATSAPP } from "../../channels/types.js";
import {
  agenteQueAtiende,
  esquemasDeHerramientas,
  handlerDeHerramienta,
  buscarHerramienta,
} from "../../agentes/_registro.js";
import { leerPromptBase } from "../../agentes/_tipos.js";
import { openrouter, LLM_MODEL } from "../llm/openrouter.js";
import { insertMensaje, listMensajes } from "../db/mensajesRepo.js";
import { getEstado, setLastAgent, marcarEscalado, marcarAvisoHumano } from "../db/estadoRepo.js";
import { enrutarMensaje } from "../../agentes/orquestador/route.js";
import { enviarSeguro, enviarVideoSeguro, enviarImageSeguro, enviarCatalogoSeguro, partirParaCaption } from "./enviar.js";
import { programarRecontacto, cancelarRecontacto } from "../queue/recontactoQueue.js";
import { intentarComando } from "./comandos.js";
import { bloqueDeCorrecciones } from "../db/correccionesRepo.js";
// [2026-09-18] El saludo con el aviso de la política de datos, que abre toda conversación nueva.
import { politica } from "../db/politicasRepo.js";
import { notificarEscalamiento } from "./notificarEquipo.js";

// [2026-09-10] Cada agente (un "bot") vive en su propia carpeta bajo src/agentes/ con su prompt
// y sus herramientas, y se registra solo (ver src/agentes/_registro.ts). Este archivo ya no sabe
// qué bots existen: le pregunta al registro cuál atiende la decisión del orquestador. Así, sumar
// o cambiar un bot no obliga a tocar el pipeline — que era uno de los dos archivos que todos
// tenían que editar, y por lo tanto conflicto de merge asegurado entre ramas.
//
// El prompt base (src/agentes/_base.md) trae la persona, el tono y las reglas que valen para
// todos los agentes, y va SIEMPRE antes del prompt específico del agente del turno.
const PROMPT_BASE = leerPromptBase();

/**
 * [2026-09-08] El modelo no sabe qué día es hoy, y ahora lo necesita: tiene que convertir
 * "el próximo sábado" o "el 20 de diciembre" a una fecha AAAA-MM-DD para cotizarle al cliente
 * el precio de ESE día. Se calcula en cada turno, en hora de Colombia (UTC-5 fijo).
 */
function fechaDeHoyEnColombia(): string {
  const ahoraBogota = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const texto = ahoraBogota.toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Para tu referencia: hoy es ${texto} en Colombia (${ahoraBogota.toISOString().slice(0, 10)}). Usalo para convertir a fecha exacta lo que diga el cliente ("este sábado", "el 20 de diciembre").`;
}

// [2026-09-10] Mensajes para cuando el orquestador decide escalar a un humano — ver
// notificarEquipo.ts para el aviso real al equipo por WhatsApp (antes esto NO existía: el
// escalamiento quedaba solo en los logs del servidor y en el panel de administración, así
// que nadie se enteraba salvo que estuviera mirando cualquiera de los dos en ese momento).
//
// Van dos mensajes distintos a propósito:
//  - MENSAJE_ESCALADO: la primera vez que se escala en esta racha (estado.escalado_en
//    todavía null). Es el aviso completo.
//  - MENSAJE_RECORDATORIO: si el cliente sigue escribiendo mientras espera al equipo, NO se
//    le repite el mensaje completo en cada mensaje suyo (se sentiría como un bot roto en
//    loop) — se le manda este, más corto, y solo si pasaron más de UMBRAL_RECORDATORIO_MS
//    desde el último aviso. Entre medio, el bot queda en silencio en vez de insistir: el
//    mensaje del cliente igual queda guardado en `mensajes` y visible en el panel para el
//    equipo.
// Exportados (no solo `const` privado) para que pruebas como e2e-orquestador.ts puedan verificar
// que este texto NO se le filtra al orquestador como si fuera parte de la charla — ver el filtro
// de `ultimosMensajes` más abajo — sin duplicar el string a mano (y arriesgarse a que se desincronicen).
export const MENSAJE_ESCALADO =
  "Ya te comunico con el equipo de La Julita para que te ayude con esto — en un momento te escriben por acá.";
export const MENSAJE_RECORDATORIO =
  "Tu mensaje ya quedó con el equipo de La Julita, en breve te responden por acá 🙏";
const UMBRAL_RECORDATORIO_MS = 15 * 60 * 1000;

/**
 * Cache en memoria por conversación — evita releer Supabase en cada hop del mismo turno.
 * La fuente de verdad real es la tabla `mensajes` (src/core/db/mensajesRepo.ts): cada
 * mensaje de usuario/bot se guarda ahí también, así el historial sobrevive a un reinicio
 * del servidor y el panel de administración lo puede mostrar (pestaña "Conversaciones").
 * Solo guardamos user/assistant en Supabase — los mensajes internos de "tool" (llamadas a
 * herramientas) quedan solo en este cache, para no ensuciar el monitor con detalles internos.
 */
const historyByUser = new Map<string, any[]>();

/**
 * [2026-09-13] Los últimos argumentos con los que `consultar_planes` corrió BIEN en cada
 * conversación (ej. `{plan: "DOMO DELUXE", fecha: "2026-09-15", personas: 1}`).
 *
 * Para qué: cuando el modelo contesta de memoria con una cifra sin verificar, el pipeline
 * fuerza una revalidación (ver más abajo). Ese forzado dependía de que el modelo OBEDECIERA el
 * `tool_choice` — y en producción se comprobó que no siempre lo hace: en el log del 2026-09-13
 * se ve el forzado dispararse y, en el hop siguiente, NINGUNA llamada a la herramienta. Cuando
 * eso pasa el turno se queda sin dato fresco y el cliente recibe el "dame un momento que
 * confirmo con el equipo" por una pregunta trivial que el bot ya había contestado bien.
 *
 * Con esto, la revalidación deja de depender del modelo: el pipeline llama la herramienta ÉL
 * MISMO, con los argumentos que ya funcionaron en esta conversación.
 */
const ultimosArgsDePlanes = new Map<string, Record<string, unknown>>();

/**
 * [2026-09-18] Los datos del GRUPO no se le vuelven a preguntar al cliente, ni se pierden porque
 * el modelo no los repitió en una llamada.
 *
 * El caso real (Daniel, 18/09): el cliente escribió "para hoy, dos personas", el bot cotizó bien
 * para dos, y tres mensajes después le preguntó "¿cuál es el domo deluxe?". En ESA llamada el
 * modelo mandó solo `plan: "domo deluxe"` — sin `personas` — así que la herramienta buscó por
 * nombre sin saber para cuántos era y le mostró a la pareja un plan de UNA persona.
 *
 * Que el modelo repita los argumentos en cada llamada es justo lo que no se le puede garantizar,
 * y el prompt ya se lo pide desde hace semanas. Así que el pipeline lo completa: si no los pasó,
 * se rellenan con los de la última consulta que sí funcionó en esta conversación. Lo que el
 * modelo SÍ manda nunca se pisa — si el cliente cambia de grupo, ese dato nuevo manda.
 *
 * Solo el grupo: la `fecha`, el `plan` o el `nivel` cambian a cada rato dentro de una misma
 * charla, y arrastrarlos sería contestar sobre algo que el cliente ya no está preguntando.
 */
/**
 * [2026-09-18] EL SALUDO CON EL AVISO DE LA POLÍTICA DE DATOS VA SIEMPRE PRIMERO.
 *
 * Regla de Daniel, después de verlo fallar: "primero, ¿por qué no envió mensaje de políticas?
 * Eso es súper importante, y debe ser el primer mensaje". Venía siendo una instrucción del
 * prompt, o sea una sugerencia: al primer mensaje del cliente el modelo decidía si saludaba o
 * contestaba. El día que una herramienta devuelve texto literal (por ejemplo `presentar_glamping`
 * ante un "info"), ese texto ES el mensaje del turno y el saludo no sale nunca — que es
 * exactamente lo que pasó a las 10:49.
 *
 * Ahora lo manda el pipeline, antes de que el turno corra: si esta conversación no tiene ni un
 * mensaje previo, sale el saludo y recién después se atiende lo que el cliente escribió. El
 * aviso de datos es lo que respalda toda la conversación que sigue, así que no puede depender de
 * lo que el modelo elija hacer.
 *
 * El texto vive en `politicas` (clave `saludo_bienvenida`) para que el equipo lo edite desde el
 * panel. El respaldo de abajo es la única copia de un texto que también está en la base, y es a
 * propósito: con la base caída, la alternativa no es "saludar con un texto de hace un mes", es
 * no darle al cliente el aviso legal. Si se cambia el oficial, hay que cambiar este también.
 */
const SALUDO_RESPALDO =
  "✨ ¡Hola! Somos La Julita Glamping 🌿🏕️ Me encantaría ayudarte a elegir el plan perfecto.\n" +
  "📌 Al continuar aceptas nuestra política de datos 👉 https://lajulitaglamping.com.co/politica-de-privacidad/\n" +
  "Cuéntame 👇 ¿vienen en pareja, en familia o con amigas? 📆 ¿y para qué fecha?";

async function saludarSiEsElPrimerMensaje(
  event: InboundEvent,
  key: string,
  history: any[],
  adapter: ChannelAdapter
): Promise<void> {
  const texto = (await politica("saludo_bienvenida")) ?? SALUDO_RESPALDO;
  const entregado = await enviarSeguro(adapter, event.externalId, texto, key);
  if (!entregado) return;

  await insertMensaje({
    canal: event.channel,
    external_id: event.externalId,
    role: "assistant",
    content: texto,
    agent_name: "saludo",
  });
  // Al historial también: si no, el modelo no sabe que ya se saludó y vuelve a presentarse.
  history.push({ role: "assistant", content: texto });
  console.log(`[runTurn] ${key}: primer mensaje de esta conversación — mandado el saludo con el aviso de datos.`);
}

const CAMPOS_DE_GRUPO = ["personas", "segmento", "adultos", "ninos"] as const;

function completarGrupoDeLaConversacion(key: string, args: Record<string, unknown>): void {
  const previos = ultimosArgsDePlanes.get(key);
  if (!previos) return;
  const heredados: string[] = [];
  for (const campo of CAMPOS_DE_GRUPO) {
    if (args[campo] == null && previos[campo] != null) {
      args[campo] = previos[campo];
      heredados.push(`${campo}=${JSON.stringify(previos[campo])}`);
    }
  }
  if (heredados.length > 0) {
    console.log(`[runTurn] ${key}: el modelo no repitió el grupo, lo completo con ${heredados.join(", ")}.`);
  }
}

const MAX_HOPS = 4;
const FALLBACK_REPLY = "Perdón, no pude procesar eso. ¿Puedes repetirlo?";

/**
 * [2026-09-11] Lo que se le dice al cliente cuando el modelo quiso mandar una cifra de dinero
 * que NO se pudo verificar contra la base y tampoco hay un texto de la herramienta que mandar
 * en su lugar (ver la verificación al final del turno). Preferimos hacerlo esperar un momento
 * antes que cotizarle un precio que puede estar mal: un precio equivocado ya prometido es una
 * discusión con el cliente y plata perdida; una demora de un minuto no es nada.
 */
const SIN_DATO_VERIFICADO =
  "Dame un momento que confirmo el valor exacto con el equipo de La Julita y te escribo enseguida 🙏";

// [2026-09-08] Cuántos mensajes del historial se le mandan al modelo en cada hop. Antes se le
// mandaba TODO el historial: en una conversación larga eso sale caro, va lento, y además
// empuja el prompt del sistema lejos del mensaje nuevo — una de las razones por las que el
// modelo se "olvidaba" de la regla de llamar la herramienta. HISTORY_TURNS cuenta turnos
// (cliente + bot), así que equivale al doble de mensajes.
const MAX_HISTORY_MESSAGES = Number(process.env.HISTORY_TURNS ?? 20) * 2;

// Temperatura baja = sigue mucho mejor las reglas del prompt (en particular "para precios
// SIEMPRE llamá consultar_planes"). No la dejamos en 0 para que el tono no salga robótico.
const TEMPERATURA_AGENTE = Number(process.env.LLM_TEMPERATURE ?? 0.3);

/**
 * [2026-09-08] Cifras de dinero que aparecen en un texto, normalizadas a puros dígitos
 * ("$ 1.690.000" -> "1690000"). Es la red de seguridad de la redacción libre: el modelo puede
 * escribir el mensaje con su propia voz, pero TODA cifra de dinero que use tiene que existir en
 * lo que devolvió la herramienta. Si aparece una que no salió de la base, el pipeline descarta
 * la redacción y manda el texto exacto de la herramienta — un precio inventado le cuesta plata
 * y credibilidad al negocio, el tono no.
 */
function montosEn(texto: string): string[] {
  const encontrados: string[] = [];
  const patrones = [/\$\s?\d[\d.,]*/g, /\b\d{1,3}(?:[.,]\d{3})+\b/g];
  for (const re of patrones) {
    for (const m of texto.matchAll(re)) {
      const digitos = m[0].replace(/\D/g, "");
      if (digitos.length >= 4) encontrados.push(digitos);
    }
  }
  return encontrados;
}

/**
 * Recorta el historial a los últimos MAX_HISTORY_MESSAGES mensajes, cuidando de no dejar un
 * mensaje de "tool" huérfano al principio: la API exige que el resultado de una herramienta
 * venga siempre después del mensaje del asistente que la llamó, así que si el corte cae en
 * medio de ese par, descartamos los resultados sueltos (si no, la llamada falla con 400).
 */
function historialParaModelo(history: any[]): any[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  const recorte = history.slice(-MAX_HISTORY_MESSAGES);
  while (recorte.length > 0 && recorte[0].role === "tool") recorte.shift();
  return recorte;
}

async function loadHistory(channel: string, externalId: string, key: string): Promise<any[]> {
  const cached = historyByUser.get(key);
  if (cached) return cached;

  // Primera vez que vemos esta conversación desde que arrancó el servidor: intentamos
  // recuperar los últimos mensajes de Supabase para no "olvidar" al cliente si el
  // servidor se reinició a mitad de una conversación.
  const guardados = await listMensajes(channel, externalId, MAX_HISTORY_MESSAGES);
  // [2026-09-14] Se mantiene created_at para que el orquestador pueda calcular tiempo
  // transcurrido y detectar cuándo el cliente está retomando (vs. continuando) una charla.
  return guardados.map((m) => ({ role: m.role, content: m.content, created_at: m.created_at }));
}

/**
 * Deja constancia en el historial en memoria de algo que el bot le escribió al cliente fuera
 * del turno normal (hoy: los recontactos automáticos). Si no, cuando el cliente contesta el
 * agente no ve ese mensaje y puede repetirse.
 */
export function registrarMensajeDelBot(canal: string, externalId: string, texto: string): void {
  const key = `${canal}:${externalId}`;
  const history = historyByUser.get(key);
  if (history) history.push({ role: "assistant", content: texto });
}

/**
 * Este es el único punto donde el bot "recibe" un mensaje — y es EXACTAMENTE el mismo
 * sin importar si event.channel es "console", "whatsapp" o "instagram". El adaptador
 * de cada canal llama a esta función (o, para canales por webhook, la ruta web la llama
 * después de adapter.parseInbound()) y le pasa su propio ChannelAdapter para poder
 * responder — el bot nunca importa nada de src/channels/whatsapp-ycloud ni de ningún
 * otro canal directamente.
 */
export async function handleInbound(event: InboundEvent, adapter: ChannelAdapter): Promise<void> {
  const key = `${event.channel}:${event.externalId}`;

  // [2026-09-13] Candado anti-bucle: nunca atender un mensaje que venga del PROPIO número del
  // bot. Desde hoy el bot se manda a sí mismo los avisos técnicos (decisión de Daniel: "por
  // ahora que se escriba a el mismo, yo lo valido"), y si alguna vez el proveedor devolviera
  // ese mensaje como entrante, el bot se respondería solo, en loop, gastando plata de API y
  // llenando la conversación. Es barato dejarlo blindado aunque hoy no pase.
  const soloDigitos = (n: string) => (n ?? "").replace(/\D/g, "");
  const numeroPropio = soloDigitos(process.env.YCLOUD_FROM_PHONE_NUMBER ?? "");
  if (numeroPropio && soloDigitos(event.externalId) === numeroPropio) {
    console.log(`[runTurn] ${key}: mensaje del propio número del bot — lo ignoro (candado anti-bucle).`);
    return;
  }

  // [2026-09-14] Reconocimiento de audio: si el cliente mandó una nota de voz (o, más adelante,
  // una imagen), acá todavía no hay texto en el evento — se resuelve ANTES que cualquier otra
  // lógica (comandos, historial, orquestador), para que todo lo de abajo siga viendo un simple
  // `event.text`, exactamente como si el cliente hubiera escrito. La descarga + transcripción
  // vive en el adaptador del canal (ver resolveMediaText en whatsapp-ycloud/adapter.ts), no acá,
  // para no mezclar código propio de YCloud en el core — mismo resultado que el reconocimiento
  // de audio de agente-ycloud-main ("Sebas Raider"), portado con la arquitectura de canales de
  // este bot.
  //
  // [2026-09-18] Restaurado — este bloque (y su contraparte en adapter.ts/client.ts/types.ts)
  // se había borrado por accidente el 2026-09-17 al integrar las funciones de video/catálogo,
  // dejando que un audio o imagen entrante avanzara por todo el pipeline como un mensaje de
  // texto VACÍO (event.text ?? ""), sin avisarle nada al cliente. Se detectó en la validación
  // de los fixes de la simulación del 2026-09-15.
  if (event.mediaType && !event.text) {
    try {
      const texto = await adapter.resolveMediaText?.(event);
      if (!texto) {
        console.warn(`[runTurn] ${key}: no se pudo obtener texto del ${event.mediaType} (canal sin resolveMediaText o vacío).`);
        await enviarSeguro(
          adapter,
          event.externalId,
          event.mediaType === "audio"
            ? "No logré entender bien tu audio 🙏 ¿Me lo puedes escribir o volver a enviar?"
            : "Por ahora no puedo ver imágenes — ¿me cuentas en texto qué necesitas? 🙏",
          key
        );
        return;
      }
      event.text = texto;
    } catch (err) {
      console.error(`[runTurn] ${key}: error procesando ${event.mediaType} del cliente:`, err);
      await enviarSeguro(
        adapter,
        event.externalId,
        "Tuve un problema escuchando tu audio 🙏 ¿Puedes intentar de nuevo o escribirlo?",
        key
      );
      return;
    }
  }

  // Comandos del equipo (/aprende, /correcciones, /borra, /confirmar, /resuelto) — solo desde
  // los números de OWNER_WHATSAPP_NUMBERS o con sesión. Se atienden ANTES de tratar el mensaje
  // como una consulta de cliente, así no ensucian el historial de ninguna conversación ni gastan
  // una llamada al LLM.
  //
  // [2026-09-16] Acá también entran los REPORTES DE FALLAS: un texto o un audio (ya transcrito
  // arriba) que empiece con "corrige", desde un número de REPORTE_FALLAS_NUMBERS, se guarda como
  // ticket en la tabla `tickets` del panel (ver comandos.ts, "REPORTES DE FALLAS"). Se le pasa
  // el medio para que el ticket diga si llegó por audio o por texto.
  const comando = await intentarComando(
    event.channel,
    event.externalId,
    event.text ?? "",
    event.mediaType === "audio" ? "audio" : "texto"
  );
  if (comando.manejado && comando.respuesta) {
    // [2026-09-17] /reset: el comando ya borró lo de la base, pero el historial de esta
    // conversación vive TAMBIÉN acá, en memoria del proceso. Si no se limpia, el bot sigue
    // recordando la charla vieja hasta el próximo reinicio y la prueba "desde ceros" arranca
    // sucia — que es justo la advertencia que estaba escrita a mano en
    // sql/limpiar-pruebas-numero.sql y que este comando existe para evitar.
    if (comando.olvidarMemoria) {
      historyByUser.delete(key);
      ultimosArgsDePlanes.delete(key);
      console.log(`[comandos] ${key}: olvidada la conversación en memoria (historial y args de planes).`);
    }
    // OJO: se loguea la etiqueta que devuelve el comando, NUNCA el texto del mensaje — puede
    // traer la clave del equipo, y los logs se leen y se comparten.
    console.log(`[comandos] ${key}: ${comando.etiquetaParaLog ?? "comando atendido"}`);
    await enviarSeguro(adapter, event.externalId, comando.respuesta, key);
    return;
  }

  const history = await loadHistory(event.channel, event.externalId, key);
  // Antes de nada: ¿es la primera vez que esta persona escribe? (ver saludarSiEsElPrimerMensaje).
  const esElPrimerMensaje = history.length === 0;
  history.push({ role: "user", content: event.text ?? "" });
  await insertMensaje({ canal: event.channel, external_id: event.externalId, role: "user", content: event.text ?? "" });

  // El saludo sale ya, sin esperar al modelo: es el aviso de la política de datos y tiene que
  // ser lo primero que lea el cliente. Lo que escribió se atiende igual, en este mismo turno.
  if (esElPrimerMensaje) await saludarSiEsElPrimerMensaje(event, key, history, adapter);

  // El orquestador decide a qué agente le toca este turno ANTES de gastar un hop de LLM
  // "de verdad" — nunca le habla al cliente, solo enruta (ver src/agentes/orquestador/prompt.md).
  const estado = await getEstado(event.channel, event.externalId);

  // [2026-09-14] Timestamps para detectar si el cliente está retomando (>30 min) o continuando.
  // `ultimoMensajeClienteEn` sale del historial; `ahoraEn` es el timestamp del evento actual.
  let ultimoMensajeClienteEn: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].role === "user") {
      ultimoMensajeClienteEn = history[i].created_at;
      break;
    }
  }

  // [2026-09-14] Al orquestador ahora se le pasa el estado REAL de la conversación, no solo el
  // mensaje suelto y `last_agent` (ver ContextoRuteo en orquestador/route.ts para el porqué).
  // Todo esto ya estaba a mano: `estado` se acaba de leer y `history` vive en memoria — así que
  // el router decide mucho mejor sin una sola consulta extra ni un milisegundo más de espera.
  const decision = await enrutarMensaje({
    mensaje: event.text ?? "",
    lastAgent: estado.last_agent,
    reservaActivaId: estado.reserva_activa_id,
    escalado: Boolean(estado.escalado_en),
    // `history` ya trae el mensaje nuevo (se agregó arriba): se saca para no repetírselo, porque
    // va aparte como el mensaje a clasificar.
    //
    // [2026-09-14] Se filtran MENSAJE_ESCALADO / MENSAJE_RECORDATORIO: son el aviso fijo del BOT
    // cuando escaló ("Ya te comunico con el equipo..."), no algo que dijo un agente real. Si
    // quedan en el historial, el orquestador los lee como si la conversación SIGUIERA escalada
    // aunque `escalado_en` ya se haya limpiado con /resuelto — y vuelve a mandar a `humano` un
    // simple "Hola" de retoma, exactamente el bucle que reportó Daniel el 14/09: /resuelto sí
    // limpiaba el estado, pero el eco de ese aviso en el historial le ganaba al estado real.
    ultimosMensajes: history
      .slice(0, -1)
      .filter((m: any) => m.content !== MENSAJE_ESCALADO && m.content !== MENSAJE_RECORDATORIO)
      .map((m: any) => ({ role: m.role, content: m.content })),
    ultimoMensajeClienteEn,
    ahoraEn: event.timestamp ?? new Date().toISOString(),
  });
  await setLastAgent(event.channel, event.externalId, decision.agente);

  if (decision.agente === "humano") {
    // [2026-09-10] `estado` se leyó ANTES del setLastAgent de arriba, así que todavía refleja
    // si esta conversación YA estaba escalada (racha en curso) o si esta es la primera vez.
    const yaEstabaEscalada = Boolean(estado.escalado_en);

    if (!yaEstabaEscalada) {
      // Primera vez en esta racha: aviso completo al cliente + aviso real al equipo por
      // WhatsApp (antes esto NO pasaba — quedaba solo en los logs, ver notificarEquipo.ts).
      console.warn(`[orquestador] Escalado a humano (${decision.motivo}) — ${key}`);
      await marcarEscalado(event.channel, event.externalId);
      await notificarEscalamiento({
        canalCliente: event.channel,
        externalIdCliente: event.externalId,
        motivo: decision.motivo,
        mensajeCliente: event.text ?? "",
      });

      history.push({ role: "assistant", content: MENSAJE_ESCALADO });
      historyByUser.set(key, history);
      await insertMensaje({
        canal: event.channel,
        external_id: event.externalId,
        role: "assistant",
        content: MENSAJE_ESCALADO,
        agent_name: "humano",
      });
      await enviarSeguro(adapter, event.externalId, MENSAJE_ESCALADO, key);
    } else {
      // Ya estaba escalada: NO se le repite el mensaje completo en cada mensaje suyo (se
      // sentiría como un bot roto en loop), y NO se vuelve a notificar al equipo por cada
      // mensaje — el mensaje ya quedó guardado en `mensajes` y visible en el panel. Solo se
      // le manda un recordatorio corto si pasó bastante rato desde el último.
      const ultimoAviso = estado.ultimo_aviso_humano_en ? new Date(estado.ultimo_aviso_humano_en).getTime() : 0;
      const pasoElUmbral = Date.now() - ultimoAviso > UMBRAL_RECORDATORIO_MS;

      // El mensaje del cliente ya quedó guardado arriba (antes de enrutar), así que acá no
      // hace falta insertMensaje de nuevo — solo decidir si le mandamos el recordatorio.
      if (pasoElUmbral) {
        await marcarAvisoHumano(event.channel, event.externalId);
        history.push({ role: "assistant", content: MENSAJE_RECORDATORIO });
        historyByUser.set(key, history);
        await insertMensaje({
          canal: event.channel,
          external_id: event.externalId,
          role: "assistant",
          content: MENSAJE_RECORDATORIO,
          agent_name: "humano",
        });
        await enviarSeguro(adapter, event.externalId, MENSAJE_RECORDATORIO, key);
      }
      // Si no pasó el umbral: silencio del bot. El mensaje del cliente ya quedó registrado
      // (ver insertMensaje más arriba, antes del enrutamiento) y visible para el equipo.
    }
    // Desde acá se encarga una persona del equipo: el bot no vuelve a insistir solo.
    await cancelarRecontacto(event.channel, event.externalId);
    return;
  }

  // Qué bot le toca a este turno, según decidió el orquestador. El registro resuelve el
  // "atiende" de cada agente y cae al de ventas si ese tema todavía no tiene bot propio.
  const agente = await agenteQueAtiende(decision.agente);
  if (!agente) {
    // No hay ningún agente cargado (algo muy roto en src/agentes/): el cliente no puede quedar
    // sin respuesta, así que se le manda el mensaje de respaldo y queda el error en el log.
    console.error(`[runTurn] no hay ningún agente disponible para "${decision.agente}" — ${key}`);
    history.push({ role: "assistant", content: FALLBACK_REPLY });
    historyByUser.set(key, history);
    await enviarSeguro(adapter, event.externalId, FALLBACK_REPLY, key);
    return;
  }

  // Lo que el equipo le fue enseñando por WhatsApp con /corrige. Se lee una vez por turno y se
  // le pasa como bloque de sistema, así una corrección aplica a todos los clientes desde el
  // mensaje siguiente sin tocar código.
  const correcciones = await bloqueDeCorrecciones();

  let hops = 0;
  let finalText: string | null = null;

  // Redacción libre: si una herramienta lo permite, su texto no se manda literal — queda como
  // respaldo y el modelo escribe el mensaje. `valoresPermitidos` junta todas las cifras de
  // dinero que salieron de la base en este turno, para verificar después que el modelo no
  // inventó ninguna.
  let textoDeRespaldo: string | null = null;
  const valoresPermitidos = new Set<string>();

  // [2026-09-11] ¿El mensaje final lo escribió el MODELO, o lo devolvió una herramienta tal cual?
  // Solo se le revisan las cifras al modelo: el texto de una herramienta con
  // `permitirRedaccion: false` (el link de pago, la pregunta de cómo quiere pagar) ya viene
  // armado con datos de la base y se manda literal — revisarlo contra `valoresPermitidos` sería
  // pedirle que se valide a sí mismo, y como esas herramientas no llenan esa lista, TODO su
  // texto quedaría marcado como inventado. Así se rompió el flujo de pago entero al ampliar la
  // verificación: al cliente le llegaba "dame un momento" en vez del link. Lo encontró
  // pruebas/e2e-pago.ts antes de salir a producción.
  let finalTextEsLiteralDeHerramienta = false;

  // [2026-09-11] Si una herramienta de este hop pide encadenar con otra puntual (ver
  // ToolResult.forzarSiguienteHerramienta — ej. registrar_datos_reserva -> enviar_datos_pago),
  // se guarda acá y se usa como `tool_choice` del PRÓXIMO hop: el modelo deja de poder
  // "contestar con texto" en vez de llamarla. Se consume una sola vez (null después de leerlo).
  let forzarProximaHerramienta: string | null = null;

  // [2026-09-16] Si alguna herramienta de este turno devolvió `videoUrl` (ver ToolResult), se
  // guarda acá para mandarlo como VIDEO NATIVO de WhatsApp (miniatura + reproducción sin salir
  // de la app) aparte del mensaje de texto normal, al final del turno. No pasa por la
  // verificación de cifras ni por la redacción libre del modelo — es un archivo, no texto.
  let videoUrlPendiente: string | null = null;

  // [2026-09-16] Similar a videoUrlPendiente, pero para imágenes (jpg, png, etc.) devueltas
  // por una herramienta. Se manda como IMAGEN NATIVA de WhatsApp.
  let imageUrlPendiente: string | null = null;

  // [2026-09-15] Mismo mecanismo que videoUrlPendiente, para el mensaje de catálogo de
  // WhatsApp (gratis — ver ToolResult.catalogoWhatsApp y REFERENCIA-CATALOGO-WHATSAPP.md).
  let catalogoWhatsAppPendiente: import("../tools/types.js").ToolResult["catalogoWhatsApp"] | null = null;

  // [2026-09-18] Mismo mecanismo, para el SEGUNDO mensaje de un texto literal largo (ver
  // ToolResult.textoAdicional — hoy solo lo usa consultar_politicas). Se guarda el de la
  // ÚLTIMA herramienta con texto literal del turno, igual que finalText/textoDeRespaldo.
  let textoAdicionalPendiente: string | null = null;

  // [2026-09-11] Red de seguridad contra un precio "de memoria": si el modelo contesta con
  // texto libre (sin llamar NINGUNA herramienta en ese hop) y ese texto menciona una cifra de
  // dinero, no hay cómo confirmar que sigue siendo la de la base — pudo haberla recordado de un
  // mensaje anterior de esta misma charla en vez de volver a preguntar. Así se descubrió: el
  // equipo cambió el precio de un plan directo en Supabase, el cliente cambió de fecha para ese
  // mismo plan, y el bot repitió el precio VIEJO que ya había dicho antes en la conversación —
  // `consultar_planes` nunca se volvió a llamar ese turno, así que la verificación de más abajo
  // (que exige que la herramienta haya corrido) no tenía nada contra qué revisar. La solución no
  // es adivinar si la cifra sigue siendo válida: es no aceptar nunca un precio que no vino de
  // llamar la herramienta EN ESE MISMO hop (ver más abajo, en el hop sin tool_calls).
  let yaForzoRevalidacionDePrecio = false;
  const tieneConsultarPlanes = agente.herramientas.some((h) => h.name === "consultar_planes");

  // [2026-09-14] Con los bots separados (reservas/pagos/postventa/ventas), un
  // `forzarSiguienteHerramienta` a veces corre, DENTRO del turno de un bot, una herramienta que en
  // realidad es de OTRO bot (ej.: `reservas` fuerza `preguntar_forma_de_pago`, que es de `pagos`).
  // Se guarda acá el dueño real de la ÚLTIMA herramienta que corrió con `agenteDueno` marcado (ver
  // core/tools/types.ts) para, al final del turno, corregir a dónde queda "pegada" la
  // conversación — si no se corrige, la regla de Pegajosidad del orquestador (ver
  // src/agentes/orquestador/prompt.md) dejaría el próximo mensaje corto del cliente ("abono",
  // "total") en el bot que ya no tiene las herramientas para seguir.
  let ultimoDuenoDeHerramienta: string | null = null;

  // [2026-09-08] Antes, un fallo del LLM o de una herramienta (timeout, error de red, error
  // interno) se iba SIN CAPTURAR — el trabajo en la cola terminaba fallando después de sus
  // reintentos y el cliente se quedaba sin ninguna respuesta, en silencio total (así se
  // descubrió: preguntas de precios que nunca contestaban, sin ningún error visible en la
  // consola). Ahora cada punto que puede fallar queda contenido: se loguea con detalle y el
  // turno sigue (o cae al FALLBACK_REPLY) en vez de dejar al cliente sin respuesta.
  while (hops < MAX_HOPS && finalText === null) {
    hops++;

    // Se consume ahora: si esta llamada trae otro tool_call que a su vez pida forzar otra
    // herramienta, ese pedido es para el hop de DESPUÉS de este, no para este mismo.
    const herramientaForzadaEsteHop = forzarProximaHerramienta;
    forzarProximaHerramienta = null;

    let completion;
    try {
      completion = await openrouter.chat.completions.create({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: PROMPT_BASE },
          { role: "system", content: agente.prompt },
          { role: "system", content: fechaDeHoyEnColombia() },
          ...(correcciones ? [{ role: "system", content: correcciones }] : []),
          ...historialParaModelo(history),
        ],
        tools: await esquemasDeHerramientas(agente.herramientas),
        // undefined = "auto" (default de siempre). Si el hop anterior pidió encadenar, se
        // fuerza acá para que el modelo NO PUEDA responder con texto en su lugar — ver
        // ToolResult.forzarSiguienteHerramienta.
        ...(herramientaForzadaEsteHop
          ? { tool_choice: { type: "function" as const, function: { name: herramientaForzadaEsteHop } } }
          : {}),
        temperature: TEMPERATURA_AGENTE,
      });
    } catch (err) {
      console.error(`[runTurn] Falló la llamada al LLM (hop ${hops}/${MAX_HOPS}) — ${key}:`, err);
      break; // finalText sigue null → abajo se manda FALLBACK_REPLY en vez de nada.
    }

    const choice = completion.choices[0].message;

    if (choice.tool_calls && choice.tool_calls.length > 0) {
      history.push({ role: "assistant", content: choice.content ?? null, tool_calls: choice.tool_calls });

      for (const call of choice.tool_calls) {
        console.log(`[runTurn] Llamando herramienta "${call.function.name}" (hop ${hops}) — ${key}`);
        try {
          const handler = handlerDeHerramienta(call.function.name, agente.herramientas);
          const args = JSON.parse(call.function.arguments || "{}");
          // Antes de llamar: si es una consulta de planes y el modelo no repitió para cuántas
          // personas es, se completa con lo que el cliente ya dijo (ver más arriba).
          if (call.function.name === "consultar_planes") completarGrupoDeLaConversacion(key, args);
          // [2026-09-11] Diagnóstico temporal: para investigar un precio viejo que seguía
          // saliendo incluso DESPUÉS de forzar la llamada a consultar_planes, hace falta ver
          // con qué argumentos la llamó el modelo (¿le pasó el `plan` y la `fecha` correctos, o
          // llamó la herramienta "en blanco"?). Sin este log no hay forma de saberlo, porque los
          // mensajes de "tool" no se guardan en Supabase (solo quedan en memoria del proceso).
          console.log(`[runTurn] args de "${call.function.name}" (hop ${hops}) — ${key}: ${JSON.stringify(args)}`);
          const toolResult = await handler(args, { channel: event.channel, externalId: event.externalId });

          const definicion = buscarHerramienta(call.function.name, agente.herramientas);
          // [2026-09-17] `forzarTextoLiteral` (ver ToolResult) deja que UNA llamada puntual de
          // una herramienta con `permitirRedaccion: true` se mande literal igual — ver el
          // comentario del campo para el porqué (consultar_planes, detalle de un plan puntual).
          const redaccionLibre =
            Boolean(definicion?.permitirRedaccion) &&
            Boolean(toolResult.reply_to_user) &&
            !toolResult.forzarTextoLiteral;

          // Se guarda el dueño real de ESTA herramienta si lo declara (ver comentario arriba,
          // antes del while) — se queda con el último, que es el que refleja el estado de la
          // conversación al final del turno.
          if (definicion?.agenteDueno) ultimoDuenoDeHerramienta = definicion.agenteDueno;

          history.push({
            role: "tool",
            tool_call_id: call.id,
            // En redacción libre el modelo necesita VER las cifras y los nombres exactos para
            // poder escribir el mensaje sin inventar nada, así que además de los datos crudos
            // se le pasa el texto que armó la herramienta como base.
            content: JSON.stringify(
              redaccionLibre
                ? { datos: toolResult.result, texto_base: toolResult.reply_to_user }
                : toolResult.result
            ),
          });

          // Se recuerdan los argumentos que SÍ funcionaron, para poder repetir la consulta sin
          // depender del modelo si más adelante hace falta revalidar un precio (ver
          // ultimosArgsDePlanes, arriba).
          if (call.function.name === "consultar_planes" && toolResult.reply_to_user) {
            ultimosArgsDePlanes.set(key, args);
          }

          if (toolResult.reply_to_user) {
            if (redaccionLibre) {
              textoDeRespaldo = toolResult.reply_to_user;
              for (const monto of montosEn(toolResult.reply_to_user)) valoresPermitidos.add(monto);
              for (const monto of montosEn(JSON.stringify(toolResult.result))) valoresPermitidos.add(monto);
              // Qué cifras quedaron habilitadas por esta llamada: son las ÚNICAS que el modelo
              // va a poder usar al redactar (ver la verificación al final del turno).
              console.log(
                `[runTurn] "${call.function.name}" (redacción libre, hop ${hops}) — ${key}: ` +
                  `montos_permitidos=${JSON.stringify([...valoresPermitidos])}`
              );
            } else {
              // Texto literal de la herramienta: se manda tal cual y no pasa por la verificación
              // de cifras (ver finalTextEsLiteralDeHerramienta, más arriba). Sus montos sí se
              // suman a los permitidos, por si un hop posterior los vuelve a mencionar.
              finalText = toolResult.reply_to_user;
              finalTextEsLiteralDeHerramienta = true;
              for (const monto of montosEn(toolResult.reply_to_user)) valoresPermitidos.add(monto);
              // El segundo mensaje (si lo hay) viaja pegado a ESTE resultado literal — si un hop
              // posterior de este mismo turno vuelve a contestar con texto literal, se descarta
              // el textoAdicional del hop anterior (mismo criterio que finalText, que también se
              // pisa hop tras hop).
              textoAdicionalPendiente = toolResult.textoAdicional ?? null;
            }
          }

          if (toolResult.forzarSiguienteHerramienta) {
            console.log(
              `[runTurn] "${call.function.name}" pide encadenar con "${toolResult.forzarSiguienteHerramienta}" ` +
                `en el próximo hop — ${key}`
            );
            forzarProximaHerramienta = toolResult.forzarSiguienteHerramienta;
          }

          if (toolResult.videoUrl) {
            console.log(`[runTurn] "${call.function.name}" pide mandar un video nativo — ${key}: ${toolResult.videoUrl}`);
            videoUrlPendiente = toolResult.videoUrl;
          }

          if (toolResult.imageUrl) {
            console.log(`[runTurn] "${call.function.name}" pide mandar una imagen nativa — ${key}: ${toolResult.imageUrl}`);
            imageUrlPendiente = toolResult.imageUrl;
          }

          if (toolResult.catalogoWhatsApp) {
            console.log(`[runTurn] "${call.function.name}" pide mandar el catálogo de WhatsApp — ${key}`);
            catalogoWhatsAppPendiente = toolResult.catalogoWhatsApp;
          }
        } catch (err) {
          // No dejamos que un error de la herramienta (ej. Supabase caído, un handler que
          // lanza) tumbe todo el turno — el modelo recibe el error como resultado de la
          // herramienta y puede intentar responder igual; si no, el fallback de abajo cubre.
          console.error(`[runTurn] Falló la herramienta "${call.function.name}" (hop ${hops}) — ${key}:`, err);
          history.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: "La herramienta falló internamente, intenta responder sin ella." }),
          });
        }
      }
    } else {
      const content = choice.content ?? "";
      if (!content.trim()) {
        console.warn("LLM devolvió content vacío", { hops, key });
      }

      const montosDeEsteTexto = montosEn(content);
      const mencionaPlata = content.trim().length > 0 && montosDeEsteTexto.length > 0;
      // [2026-09-13] Caso real (log de Daniel): el cliente pregunta algo tipo "¿qué incluye y
      // cuánto cuesta?" sobre un plan que YA se cotizó (con datos reales) más temprano en este
      // MISMO turno — el modelo, al redactar, repite esa MISMA cifra ya verificada en vez de
      // volver a llamar la herramienta. Antes esto se descartaba igual y se forzaba otra vuelta
      // a `consultar_planes` — un hop extra de más (más lento) para terminar validando un
      // número que ya estaba validado. Ahora solo se fuerza la revalidación si el texto trae
      // alguna cifra que TODAVÍA no esté entre las permitidas de este turno — una cifra que ya
      // vino de una llamada real a la base en este mismo turno no necesita otra vuelta.
      const hayCifraSinVerificarEsteTurno = montosDeEsteTexto.some((m) => !valoresPermitidos.has(m));

      if (mencionaPlata && hayCifraSinVerificarEsteTurno && tieneConsultarPlanes && !yaForzoRevalidacionDePrecio) {
        // Ver el comentario de yaForzoRevalidacionDePrecio más arriba: se descarta esta
        // respuesta entera (no se guarda en el historial ni se manda) y se fuerza consultar_planes
        // en el próximo hop, para que la cifra que diga después quede anclada a la base y pase
        // por la verificación de abajo. Solo se fuerza UNA vez por turno, para no encadenar hops
        // de más si el modelo insiste en contestar sin apoyarse en la herramienta.
        console.warn(
          `[runTurn] Texto libre con cifras de dinero sin verificar en este turno — ` +
            `${key}: lo descarto y confirmo el precio actual contra la base.`
        );
        yaForzoRevalidacionDePrecio = true;

        // [2026-09-13] La revalidación la hace el PIPELINE, no el modelo. Antes acá solo se
        // ponía `forzarProximaHerramienta` (tool_choice forzado) y se confiaba en que el modelo
        // llamara la herramienta en el hop siguiente — en el log real del 2026-09-13 se ve que
        // NO lo hizo, y el turno terminó sin ningún dato fresco: el cliente recibió "dame un
        // momento que confirmo con el equipo" por una pregunta que el bot ya sabía contestar.
        // Ahora se llama la herramienta directamente, con los argumentos que ya funcionaron en
        // esta conversación, y el resultado se le entrega al modelo como contexto del sistema
        // (no como mensaje `tool`: la API exige que un `tool` venga pegado a su `tool_call`, y
        // acá no hubo ninguno). El `tool_choice` forzado se deja igual, por si el modelo sí
        // decide llamarla: dos fuentes frescas no molestan, una cifra inventada sigue sin pasar.
        const argsRecordados = ultimosArgsDePlanes.get(key);
        if (argsRecordados) {
          try {
            const handler = handlerDeHerramienta("consultar_planes", agente.herramientas);
            console.log(
              `[runTurn] revalidación directa de "consultar_planes" (hop ${hops}) — ${key}: ` +
                `${JSON.stringify(argsRecordados)}`
            );
            const fresco = await handler(argsRecordados, { channel: event.channel, externalId: event.externalId });
            if (fresco.reply_to_user) {
              textoDeRespaldo = fresco.reply_to_user;
              for (const monto of montosEn(fresco.reply_to_user)) valoresPermitidos.add(monto);
              for (const monto of montosEn(JSON.stringify(fresco.result))) valoresPermitidos.add(monto);
              history.push({
                role: "system",
                content:
                  "Datos frescos de la base para responder este mensaje (consultar_planes, " +
                  `${JSON.stringify(argsRecordados)}): ${JSON.stringify({ datos: fresco.result, texto_base: fresco.reply_to_user })}`,
              });
              console.log(
                `[runTurn] revalidación directa OK — ${key}: montos_permitidos=${JSON.stringify([...valoresPermitidos])}`
              );
            }
          } catch (err) {
            // Que falle la revalidación no puede tumbar el turno: sin dato fresco el mensaje del
            // modelo simplemente no va a pasar la verificación de abajo, que es el comportamiento
            // seguro de siempre.
            console.error(`[runTurn] la revalidación directa de "consultar_planes" falló — ${key}:`, err);
          }
        } else {
          console.warn(
            `[runTurn] no hay argumentos previos de "consultar_planes" para ${key} — ` +
              "dependo del tool_choice forzado para revalidar."
          );
        }

        forzarProximaHerramienta = "consultar_planes";
        // No seteamos finalText: el while sigue (si quedan hops).
      } else {
        // Solo asignamos si hay contenido real; si viene vacío, dejamos finalText en null
        // para no cortar el ciclo con un string vacío (eso rompía el envío a YCloud).
        finalText = content.trim().length > 0 ? content : null;
        finalTextEsLiteralDeHerramienta = false; // esto lo escribió el modelo: hay que revisarlo
      }
    }
  }

  // Si tras agotar los hops seguimos sin texto útil, usamos el texto de la herramienta (si
  // hubo) y, en última instancia, el mensaje de respaldo.
  let reply = finalText && finalText.trim().length > 0 ? finalText : (textoDeRespaldo ?? FALLBACK_REPLY);

  // Traza corta de la verificación: qué cifras trae el mensaje que el modelo quiere mandar y
  // cuáles están habilitadas. Si algo sale mal en producción, con esta línea sola se entiende.
  if (finalText && !finalTextEsLiteralDeHerramienta && montosEn(finalText).length > 0) {
    console.log(
      `[runTurn] verificación de cifras — ${key}: en_el_mensaje=${JSON.stringify(montosEn(finalText))} | ` +
        `permitidas=${JSON.stringify([...valoresPermitidos])}`
    );
  }

  // Verificación de la redacción libre: toda cifra de dinero del mensaje tiene que venir de la
  // base. Si el modelo se inventó un valor (o redondeó uno), se manda el texto exacto de la
  // herramienta en vez de su redacción.
  //
  // [2026-09-11] Antes esta verificación SOLO corría si además había `textoDeRespaldo` y la
  // lista de valores permitidos no estaba vacía. Ese "y" era un agujero: si la herramienta no
  // llegaba a devolver datos (Supabase caído, la consulta vuelve vacía, la herramienta falla),
  // `valoresPermitidos` quedaba vacío, la verificación no corría, y el modelo podía mandarle al
  // cliente CUALQUIER cifra — justamente en el momento en que menos se le puede creer, porque
  // no tiene ningún dato fresco con qué contrastar. Se descubrió corriendo esta misma prueba
  // con la base devolviendo vacío: el bot le mandaba al cliente el precio viejo sin que nada
  // lo frenara. Ahora la regla es simple y sin excepciones: si el mensaje menciona plata, cada
  // cifra tiene que estar en lo que devolvió una herramienta en ESTE turno; si no hay con qué
  // verificarla, no sale.
  if (finalText && !finalTextEsLiteralDeHerramienta) {
    const inventados = montosEn(finalText).filter((monto) => !valoresPermitidos.has(monto));
    if (inventados.length > 0) {
      console.error(
        `[runTurn] La redacción del modelo traía cifras que NO salieron de la base (${inventados.join(", ")}) — ${key}: ` +
          (textoDeRespaldo ? "mando el texto exacto de la herramienta." : "no hay dato verificado, mando el mensaje de respaldo.")
      );
      reply = textoDeRespaldo ?? SIN_DATO_VERIFICADO;
    }
  }

  // [2026-09-14] Corrección de a qué bot queda "pegada" la conversación — ver el comentario junto
  // a `ultimoDuenoDeHerramienta`, antes del while. Se hace DESPUÉS del turno (no reemplaza el
  // `setLastAgent` de arriba, lo corrige) porque recién acá se sabe cuál fue la última herramienta
  // que de verdad corrió.
  if (ultimoDuenoDeHerramienta && ultimoDuenoDeHerramienta !== decision.agente) {
    console.log(
      `[runTurn] el turno lo clasificó el orquestador como "${decision.agente}" pero la última ` +
        `herramienta que corrió es de "${ultimoDuenoDeHerramienta}" — corrijo last_agent para el ` +
        `próximo mensaje — ${key}`
    );
    await setLastAgent(event.channel, event.externalId, ultimoDuenoDeHerramienta);
  }

  history.push({ role: "assistant", content: reply });
  historyByUser.set(key, history);
  await insertMensaje({
    canal: event.channel,
    external_id: event.externalId,
    role: "assistant",
    content: reply,
    agent_name: decision.agente,
  });

  // [2026-09-16 → 2026-09-17] El video (si alguna herramienta lo pidió, ver videoUrlPendiente
  // arriba) va antes que el texto — pedido de Daniel: que el cliente vea primero el video del
  // plan y enseguida el precio y los ganchos.
  //
  // Probado en real: mandarlos como DOS mensajes (aunque el video se pida primero en el código)
  // no garantiza el orden en que el cliente los VE — WhatsApp tarda más en procesar y entregar
  // un video (lo descarga, le saca miniatura) que un texto plano, que llega casi al instante, así
  // que a veces el texto se veía primero igual. La única forma de garantizar el orden de verdad
  // es que no sean dos mensajes: el texto va como CAPTION del mismo mensaje del video, si cabe
  // en el límite de WhatsApp para pie de foto (1024 caracteres — se deja margen en 1000).
  //
  // [2026-09-17] Cuando el texto NO cabe como pie de foto, el video ya no se manda solo: se
  // parte el texto (ver `partirParaCaption`) y el video viaja igual con la primera parte de
  // caption, mientras el resto sigue en un segundo mensaje. Antes, en ese caso, llegaba el
  // video por un lado y todo el texto por otro — "separaste el mensaje del video", lo reportó
  // Daniel probando el PLAN CLASICO VIP. Con los datos de hoy solo se parten 2 de los 20 planes
  // (CLASICO VIP y PARAISO, de más de 20 ítems cada uno): el límite de WhatsApp para un pie de
  // foto son 1024 caracteres y contra eso no hay nada que hacer del lado del bot.
  let entregado: boolean;
  if (videoUrlPendiente) {
    const [caption, resto] = partirParaCaption(reply, LIMITE_CAPTION_WHATSAPP);
    const okConCaption = await enviarVideoSeguro(adapter, event.externalId, videoUrlPendiente, key, caption);
    if (okConCaption) {
      entregado = true;
      // La continuación va aparte sí o sí: no cabía en el mismo mensaje.
      if (resto) await enviarSeguro(adapter, event.externalId, resto, key);
    } else {
      // Si el video con caption falló (ej. el archivo no cargó), no dejamos al cliente sin
      // nada: se manda el texto COMPLETO —no la parte cortada— en un mensaje normal.
      entregado = await enviarSeguro(adapter, event.externalId, reply, key);
    }
  } else if (imageUrlPendiente) {
    // [2026-09-16] Las imágenes funcionan igual que los videos: se parten si el texto no cabe
    // como pie de foto (caption), y si falla el envío de la imagen se manda el texto completo.
    const [caption, resto] = partirParaCaption(reply, LIMITE_CAPTION_WHATSAPP);
    const okConCaption = await enviarImageSeguro(adapter, event.externalId, imageUrlPendiente, key, caption);
    if (okConCaption) {
      entregado = true;
      // La continuación va aparte sí o sí: no cabía en el mismo mensaje.
      if (resto) await enviarSeguro(adapter, event.externalId, resto, key);
    } else {
      // Si la imagen con caption falló, no dejamos al cliente sin nada.
      entregado = await enviarSeguro(adapter, event.externalId, reply, key);
    }
  } else {
    entregado = await enviarSeguro(adapter, event.externalId, reply, key);
  }
  // [2026-09-18] El resto de un texto literal largo (ver textoAdicionalPendiente) va justo
  // después del mensaje principal — se manda solo si el mensaje principal SÍ se entregó (si
  // falló, reintentar la primera parte importa más que mandar la segunda suelta).
  if (entregado && textoAdicionalPendiente) {
    await enviarSeguro(adapter, event.externalId, textoAdicionalPendiente, key);
  }

  // [2026-09-15] El catálogo (si alguna herramienta lo pidió) va DESPUÉS del texto (y del
  // video, si también hubo) — es un mensaje aparte, no reemplaza nada de lo anterior.
  if (catalogoWhatsAppPendiente) {
    await enviarCatalogoSeguro(adapter, event.externalId, catalogoWhatsAppPendiente, key);
  }

  // Recontacto automático: si el cliente no vuelve a escribir, el bot retoma la conversación
  // a los 20 minutos, y después a las 3 y a las 6 horas (ver src/core/queue/recontactoQueue.ts).
  // Se reprograma en CADA respuesta, así que mientras la charla siga viva el reloj se reinicia
  // solo y nunca hay más de un recordatorio pendiente por cliente.
  if (entregado) {
    await programarRecontacto(event.channel, event.externalId, 1, new Date().toISOString());
  }
}
