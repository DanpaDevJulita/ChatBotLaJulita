import fs from "node:fs";
import path from "node:path";
import type { ChannelAdapter, InboundEvent } from "../../channels/types.js";
import { getToolSchemas, getToolHandler, getTool, toolsVentas, toolsPostventa } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import { openrouter, LLM_MODEL } from "../llm/openrouter.js";
import { insertMensaje, listMensajes } from "../db/mensajesRepo.js";
import { getEstado, setLastAgent } from "../db/estadoRepo.js";
import { enrutarMensaje } from "../orchestrator/route.js";
import { enviarSeguro } from "./enviar.js";
import { programarRecontacto, cancelarRecontacto } from "../queue/recontactoQueue.js";
import { intentarComando } from "./comandos.js";
import { bloqueDeCorrecciones } from "../db/correccionesRepo.js";

// [2026-09-10] Prompt base (persona/tono/reglas que valen para TODOS los agentes) + un prompt
// específico por agente, según lo que decida el orquestador (decision.agente, ver
// prompts/orquestador.md). `informacion`, `reservas` y `pagos` siguen compartiendo prompt y
// herramientas (prompts/system.md) hasta que se separen de verdad (ver prompts/agentes/*.md);
// `postventa` ya tiene su propio prompt (prompts/agentes/postventa.md) y su propio set de
// herramientas (toolsPostventa, ver src/core/tools/registry.ts).
const PROMPT_BASE = fs.readFileSync(path.join(process.cwd(), "prompts", "base.md"), "utf-8");
const PROMPT_VENTAS = fs.readFileSync(path.join(process.cwd(), "prompts", "system.md"), "utf-8");
const PROMPT_POSTVENTA = fs.readFileSync(
  path.join(process.cwd(), "prompts", "agentes", "postventa.md"),
  "utf-8"
);

interface ConfigAgente {
  promptEspecifico: string;
  tools: ToolDefinition[];
}

const CONFIG_VENTAS: ConfigAgente = { promptEspecifico: PROMPT_VENTAS, tools: toolsVentas };
const CONFIG_POSTVENTA: ConfigAgente = { promptEspecifico: PROMPT_POSTVENTA, tools: toolsPostventa };

// reservas y pagos: ver prompts/agentes/reservas.md y pagos.md — todavía [PENDIENTE] (no tienen
// herramientas propias construidas), así que por ahora los sigue atendiendo el mismo prompt y
// las mismas herramientas de ventas. Cuando se construyan, cada uno suma su entrada acá.
const CONFIG_POR_AGENTE: Record<string, ConfigAgente> = {
  informacion: CONFIG_VENTAS,
  reservas: CONFIG_VENTAS,
  pagos: CONFIG_VENTAS,
  postventa: CONFIG_POSTVENTA,
};

function configDeAgente(agente: string): ConfigAgente {
  return CONFIG_POR_AGENTE[agente] ?? CONFIG_VENTAS;
}

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

// Mensaje fijo para cuando el orquestador decide escalar a un humano. Todavía no hay
// notificación automática al equipo (WhatsApp/email, como leadNotify.ts en
// agente-ycloud-main) — por ahora el escalamiento queda en los logs del servidor y en el
// monitor del panel de administración (el mensaje del cliente sigue quedando ahí). Portar
// esa notificación es trabajo pendiente, no de este cambio.
const MENSAJE_ESCALADO =
  "Ya te comunico con el equipo de La Julita para que te ayude con esto — en un momento te escriben por acá.";

/**
 * Cache en memoria por conversación — evita releer Supabase en cada hop del mismo turno.
 * La fuente de verdad real es la tabla `mensajes` (src/core/db/mensajesRepo.ts): cada
 * mensaje de usuario/bot se guarda ahí también, así el historial sobrevive a un reinicio
 * del servidor y el panel de administración lo puede mostrar (pestaña "Conversaciones").
 * Solo guardamos user/assistant en Supabase — los mensajes internos de "tool" (llamadas a
 * herramientas) quedan solo en este cache, para no ensuciar el monitor con detalles internos.
 */
const historyByUser = new Map<string, any[]>();
const MAX_HOPS = 4;
const FALLBACK_REPLY = "Perdón, no pude procesar eso. ¿Puedes repetirlo?";

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
  return guardados.map((m) => ({ role: m.role, content: m.content }));
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

  // Comandos del equipo (/corrige, /correcciones, /borra) — solo desde los números de
  // OWNER_WHATSAPP_NUMBERS. Se atienden ANTES de tratar el mensaje como una consulta de
  // cliente, así no ensucian el historial de ninguna conversación ni gastan una llamada al LLM.
  const comando = await intentarComando(event.channel, event.externalId, event.text ?? "");
  if (comando.manejado && comando.respuesta) {
    // OJO: se loguea la etiqueta que devuelve el comando, NUNCA el texto del mensaje — puede
    // traer la clave del equipo, y los logs se leen y se comparten.
    console.log(`[comandos] ${key}: ${comando.etiquetaParaLog ?? "comando atendido"}`);
    await enviarSeguro(adapter, event.externalId, comando.respuesta, key);
    return;
  }

  const history = await loadHistory(event.channel, event.externalId, key);
  history.push({ role: "user", content: event.text ?? "" });
  await insertMensaje({ canal: event.channel, external_id: event.externalId, role: "user", content: event.text ?? "" });

  // El orquestador decide a qué agente le toca este turno ANTES de gastar un hop de LLM
  // "de verdad" — nunca le habla al cliente, solo enruta (ver prompts/orquestador.md).
  const estado = await getEstado(event.channel, event.externalId);
  const decision = await enrutarMensaje({ mensaje: event.text ?? "", lastAgent: estado.last_agent });
  await setLastAgent(event.channel, event.externalId, decision.agente);

  if (decision.agente === "humano") {
    console.warn(`[orquestador] Escalado a humano (${decision.motivo}) — ${key}`);
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
    // Desde acá se encarga una persona del equipo: el bot no vuelve a insistir solo.
    await cancelarRecontacto(event.channel, event.externalId);
    return;
  }

  // Qué prompt y qué herramientas le tocan a este turno, según decidió el orquestador.
  const config = configDeAgente(decision.agente);

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

  // [2026-09-08] Antes, un fallo del LLM o de una herramienta (timeout, error de red, error
  // interno) se iba SIN CAPTURAR — el trabajo en la cola terminaba fallando después de sus
  // reintentos y el cliente se quedaba sin ninguna respuesta, en silencio total (así se
  // descubrió: preguntas de precios que nunca contestaban, sin ningún error visible en la
  // consola). Ahora cada punto que puede fallar queda contenido: se loguea con detalle y el
  // turno sigue (o cae al FALLBACK_REPLY) en vez de dejar al cliente sin respuesta.
  while (hops < MAX_HOPS && finalText === null) {
    hops++;

    let completion;
    try {
      completion = await openrouter.chat.completions.create({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: PROMPT_BASE },
          { role: "system", content: config.promptEspecifico },
          { role: "system", content: fechaDeHoyEnColombia() },
          ...(correcciones ? [{ role: "system", content: correcciones }] : []),
          ...historialParaModelo(history),
        ],
        tools: await getToolSchemas(config.tools),
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
          const handler = getToolHandler(call.function.name, config.tools);
          const args = JSON.parse(call.function.arguments || "{}");
          const toolResult = await handler(args, { channel: event.channel, externalId: event.externalId });

          const definicion = getTool(call.function.name, config.tools);
          const redaccionLibre = Boolean(definicion?.permitirRedaccion) && Boolean(toolResult.reply_to_user);

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

          if (toolResult.reply_to_user) {
            if (redaccionLibre) {
              textoDeRespaldo = toolResult.reply_to_user;
              for (const monto of montosEn(toolResult.reply_to_user)) valoresPermitidos.add(monto);
              for (const monto of montosEn(JSON.stringify(toolResult.result))) valoresPermitidos.add(monto);
            } else {
              finalText = toolResult.reply_to_user;
            }
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
      // Solo asignamos si hay contenido real; si viene vacío, dejamos finalText en null
      // para no cortar el ciclo con un string vacío (eso rompía el envío a YCloud).
      finalText = content.trim().length > 0 ? content : null;
    }
  }

  // Si tras agotar los hops seguimos sin texto útil, usamos el texto de la herramienta (si
  // hubo) y, en última instancia, el mensaje de respaldo.
  let reply = finalText && finalText.trim().length > 0 ? finalText : (textoDeRespaldo ?? FALLBACK_REPLY);

  // Verificación de la redacción libre: toda cifra de dinero del mensaje tiene que venir de la
  // base. Si el modelo se inventó un valor (o redondeó uno), se manda el texto exacto de la
  // herramienta en vez de su redacción.
  if (finalText && textoDeRespaldo && valoresPermitidos.size > 0) {
    const inventados = montosEn(finalText).filter((monto) => !valoresPermitidos.has(monto));
    if (inventados.length > 0) {
      console.error(
        `[runTurn] La redacción del modelo traía cifras que NO salieron de la base (${inventados.join(", ")}) — ${key}: ` +
          "mando el texto exacto de la herramienta."
      );
      reply = textoDeRespaldo;
    }
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

  const entregado = await enviarSeguro(adapter, event.externalId, reply, key);

  // Recontacto automático: si el cliente no vuelve a escribir, el bot retoma la conversación
  // a los 20 minutos, y después a las 3 y a las 6 horas (ver src/core/queue/recontactoQueue.ts).
  // Se reprograma en CADA respuesta, así que mientras la charla siga viva el reloj se reinicia
  // solo y nunca hay más de un recordatorio pendiente por cliente.
  if (entregado) {
    await programarRecontacto(event.channel, event.externalId, 1, new Date().toISOString());
  }
}
