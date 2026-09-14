/**
 * [2026-09-13] Envío de correo — hoy solo lo usa el aviso técnico al equipo de desarrollo (ver
 * notificarDesarrollo.ts). Daniel pidió el aviso por correo a daniel.pataquiva@lajulitadevelopment.site
 * pero todavía no definió con qué proveedor lo manda ("dejalo pendiente, para configurar") — así
 * que este archivo queda LISTO pero sin credenciales: usa SMTP estándar (funciona con Gmail +
 * "contraseña de aplicación", con Resend/SendGrid/Mailgun en modo SMTP, o con cualquier otro
 * proveedor que dé host/usuario/clave) para no depender de un proveedor puntual.
 *
 * Mientras las variables SMTP_* no estén puestas en .env, `enviarCorreo` NO intenta mandar nada
 * (nodemailer con datos vacíos solo lanzaría un error) — deja bien claro en el log que el correo
 * quedó pendiente de configurar, para que no se pierda silenciosamente, y quien llama (
 * notificarDesarrollo.ts) igual deja el aviso completo en los logs del servidor.
 */
import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "587");
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";
// Remitente que ve quien recibe el correo. Si no se pone, se usa SMTP_USER.
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transportador: ReturnType<typeof nodemailer.createTransport> | null = null;
let yaAvisoSinConfigurar = false;

export function emailConfigurado(): boolean {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function obtenerTransportador() {
  if (transportador) return transportador;
  transportador = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transportador;
}

/**
 * Manda un correo simple de texto plano. Nunca lanza: si falla (o si no está configurado) deja
 * el motivo en console.error y devuelve false — quien llama decide qué tan grave es eso (hoy,
 * notificarDesarrollo.ts igual deja el aviso completo en los logs, así que un correo que no sale
 * no se traduce en un aviso perdido del todo).
 */
export async function enviarCorreo(params: { para: string; asunto: string; texto: string }): Promise<boolean> {
  if (!emailConfigurado()) {
    if (!yaAvisoSinConfigurar) {
      console.warn(
        "[email] SMTP_HOST/SMTP_USER/SMTP_PASS no están configurados todavía (pendiente — Daniel " +
          "decidió configurarlo más adelante): los avisos técnicos por correo quedan SOLO en los " +
          "logs del servidor mientras tanto, no le llega nada a " +
          params.para + "."
      );
      yaAvisoSinConfigurar = true;
    }
    return false;
  }

  try {
    await obtenerTransportador().sendMail({
      from: SMTP_FROM,
      to: params.para,
      subject: params.asunto,
      text: params.texto,
    });
    return true;
  } catch (err) {
    console.error("[email] no se pudo enviar el correo:", (err as any)?.message ?? err);
    return false;
  }
}
