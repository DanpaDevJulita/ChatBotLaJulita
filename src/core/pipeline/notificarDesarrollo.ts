import { getChannel } from "../../channels/registry.js";
import { debeAlertar, registrarAlerta } from "../db/alertasTecnicasRepo.js";

/**
 * [2026-09-13] Aviso al equipo de DESARROLLO cuando un servicio externo falla — LobbyPMS, Bold,
 * Supabase, etc. — SIN IMPORTAR si el bot se las arregló solo para el cliente en ese momento
 * (ej. cayó a un camino de respaldo, o mostró un mensaje genérico). Pedido explícito de Daniel:
 *
 *   "cuando pasa algo como esto que algun servicio falla, el bot lo detecta, internamente sin
 *   dañar el flujo con el usuario (si pudo resolver el solo super bien como este caso) pero
 *   inmediato detecta un servicio caido debe informar al equipo de desarrollo de la julita pra
 *   que identifiquye el error y no tengamos malos entendidos con los clientes o fallas grandes"
 *
 * Es DISTINTO del aviso de notificarEquipo.ts (WhatsApp al equipo de VENTAS cuando un CLIENTE
 * pide hablar con una persona): ese es sobre UNA conversación puntual; este es sobre un SERVICIO
 * caído, sin cliente ni conversación de por medio — puede dispararse aunque el bot nunca haya
 * necesitado escalar nada a ventas.
 *
 * Canal, DECISIÓN 2026-09-13 (cambió una vez ya en el mismo día):
 *   - Primero se pidió por CORREO a daniel.pataquiva@lajulitadevelopment.site. Después, mismo
 *     día, Daniel decidió dejar el correo en pausa ("lo dejamos en pendientes, para más
 *     adelante" — ver src/core/integrations/email.ts, que queda listo pero sin usarse) y usar
 *     MIENTRAS TANTO WhatsApp, al mismo número del bot (+573246166787 — el mismo de
 *     YCLOUD_FROM_PHONE_NUMBER): "por ahora que se escriba a el mismo, yo lo valido y vamos
 *     arreglando". O sea: el bot se manda el aviso técnico A SÍ MISMO por WhatsApp, y Daniel (que
 *     tiene acceso a ese número) lo revisa ahí mientras se decide un canal definitivo.
 *   - Máximo un aviso cada 2 horas por la MISMA falla (`clave`) mientras siga activa — para no
 *     inundar el WhatsApp si un servicio se cae por horas. Ver alertasTecnicasRepo.ts para el
 *     throttle (compartido entre procesos, igual que conversacionActivaRepo.ts).
 *
 * Cambiar esto de vuelta a correo (cuando se retome ese pendiente) es solo cambiar el bloque de
 * envío de acá abajo por `enviarCorreo(...)` — el throttle y el resto de esta función no cambian.
 */
const VENTANA_MS = 2 * 60 * 60 * 1000; // 2 horas — pedido exacto de Daniel.
const NUMERO_ALERTA_DESARROLLO = process.env.ALERTA_TECNICA_WHATSAPP || "+573246166787";

export async function alertarFalloTecnico(params: {
  /** Identifica el TIPO de falla, no la conversación — ej. "lobbypms:ip_no_autorizada". */
  clave: string;
  /** Una línea corta para el encabezado del WhatsApp y el resumen del log. */
  titulo: string;
  /** El detalle completo (mensaje de error, contexto) — va en el cuerpo del aviso y en el log. */
  detalle: string;
}): Promise<void> {
  const { clave, titulo, detalle } = params;

  // Siempre queda en los logs del servidor, pase lo que pase con el throttle o el envío — esto
  // es justo lo que Daniel pidió que NUNCA se pierda silenciosamente.
  console.error(`[alerta-tecnica:${clave}] ${titulo} — ${detalle}`);

  let corresponde: boolean;
  try {
    corresponde = await debeAlertar(clave, VENTANA_MS);
  } catch (err) {
    console.error("[notificarDesarrollo] no pude consultar el throttle, aviso igual por las dudas:", err);
    corresponde = true;
  }
  if (!corresponde) return; // ya se avisó de esta misma falla hace menos de 2 horas.

  const texto =
    `🛠️ Aviso técnico — bot La Julita\n\n` +
    `Un servicio externo falló.\n\n` +
    `Tipo de falla: ${clave}\n` +
    `${titulo}\n\n` +
    `Detalle:\n${detalle}\n\n` +
    `Este aviso se repite como máximo cada 2 horas mientras la misma falla siga activa.`;

  try {
    const whatsapp = getChannel("whatsapp");
    await whatsapp.send({ to: NUMERO_ALERTA_DESARROLLO, text: texto });
  } catch (err) {
    // Nunca deja que un fallo ACÁ (WhatsApp caído, número mal puesto) tumbe el turno del
    // cliente — el log de arriba ya deja constancia completa igual.
    console.error(`[notificarDesarrollo] no se pudo mandar el aviso técnico por WhatsApp a ${NUMERO_ALERTA_DESARROLLO}:`, err);
  }

  // Se registra el intento haya salido o no el envío: si falla por algo transitorio, igual no
  // tiene sentido reintentar cada mensaje de cliente en los próximos 2 minutos — el log de
  // arriba ya deja constancia completa, y en 2 horas se vuelve a intentar.
  await registrarAlerta(clave, `${titulo} — ${detalle}`);
}
