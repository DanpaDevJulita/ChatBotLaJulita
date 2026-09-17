/**
 * Genera el token que el bot usara para conectarse a Supabase con el rol
 * restringido `bot_lajulita` en vez de la llave de servicio.
 *
 * Como se usa:
 *   1. Supabase -> Project Settings -> API -> JWT Settings -> copiar "JWT Secret"
 *   2. node generar-token-bot.mjs "<JWT_SECRET>" "<PROJECT_REF>"
 *      (PROJECT_REF es el wcjoqkvk... de la URL del proyecto)
 *   3. Pegar el token que imprime en el .env del bot como SUPABASE_BOT_KEY
 *
 * El token no caduca hasta dentro de 10 anios. Es un secreto: tratalo como
 * una contrasenia, no lo subas a git ni lo pegues en un chat.
 */

import crypto from "node:crypto";

const [, , secreto, projectRef] = process.argv;

if (!secreto || !projectRef) {
  console.error("Uso: node generar-token-bot.mjs \"<JWT_SECRET>\" \"<PROJECT_REF>\"");
  process.exit(1);
}

const base64url = (obj) =>
  Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const ahora = Math.floor(Date.now() / 1000);

const encabezado = { alg: "HS256", typ: "JWT" };
const cuerpo = {
  iss: "supabase",
  ref: projectRef,
  role: "bot_lajulita", // <- esto es lo que hace que PostgREST use el rol restringido
  iat: ahora,
  exp: ahora + 60 * 60 * 24 * 365 * 10,
};

const partes = `${base64url(encabezado)}.${base64url(cuerpo)}`;
const firma = crypto
  .createHmac("sha256", secreto)
  .update(partes)
  .digest("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

console.log("\nSUPABASE_BOT_KEY=" + `${partes}.${firma}` + "\n");
console.log("Rol:", cuerpo.role);
console.log("Vence:", new Date(cuerpo.exp * 1000).toISOString().slice(0, 10));
