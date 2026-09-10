/**
 * Levanta el túnel de Cloudflare y te deja servida la dirección para pegar en YCloud.
 *
 *   node scripts/tunel.mjs
 *
 * ¿Por qué existe? Porque un "quick tunnel" de trycloudflare.com genera una URL NUEVA cada vez
 * que se levanta, y `cloudflared` la imprime una sola vez, en medio de 30 líneas de log:
 *
 *     INF |  Your quick Tunnel has been created! Visit it at ...  |
 *     INF |  https://algo-random.trycloudflare.com                |
 *
 * Este script mira esa salida, pesca la URL, le pega la ruta del webhook y te la muestra
 * grande. Además la guarda en `tunel-actual.txt`, así no se pierde aunque cierres la consola.
 *
 * OJO: mientras no actualices el webhook en YCloud, los clientes te escriben y el bot no recibe
 * NADA — y no aparece ningún error en la consola. Es un silencio difícil de notar.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const PUERTO = process.env.PORT ?? "3000";
const RUTA_WEBHOOK = "/webhooks/whatsapp"; // definida en src/web/server.ts
const ARCHIVO = "tunel-actual.txt";

const cloudflared = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PUERTO}`], {
  shell: process.platform === "win32",
});

let urlEncontrada = null;

function revisar(texto) {
  process.stdout.write(texto);
  if (urlEncontrada) return;

  const m = texto.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  if (!m) return;

  urlEncontrada = m[0];
  const webhook = urlEncontrada + RUTA_WEBHOOK;

  const aviso = [
    "",
    "=".repeat(78),
    "  TÚNEL LISTO",
    "",
    `  URL del túnel:  ${urlEncontrada}`,
    "",
    "  PEGÁ ESTO EN EL WEBHOOK DE WHATSAPP EN YCLOUD:",
    "",
    `      ${webhook}`,
    "",
    "  (no te olvides de la ruta /webhooks/whatsapp al final: si pegás solo el dominio,",
    "   YCloud manda los mensajes a la raíz, Express responde 404 y el bot no recibe nada)",
    "",
    `  Guardado también en ${ARCHIVO}`,
    "=".repeat(78),
    "",
  ].join("\n");

  console.log(aviso);

  try {
    fs.writeFileSync(
      ARCHIVO,
      `${new Date().toISOString()}\ntunel:   ${urlEncontrada}\nwebhook: ${webhook}\n`,
      "utf-8"
    );
  } catch (err) {
    console.error(`[tunel] No pude guardar ${ARCHIVO}:`, err.message);
  }
}

// cloudflared escribe sus logs por stderr, no por stdout: hay que mirar los dos.
cloudflared.stdout.on("data", (d) => revisar(d.toString()));
cloudflared.stderr.on("data", (d) => revisar(d.toString()));

cloudflared.on("error", (err) => {
  console.error(
    "\n[tunel] No pude ejecutar cloudflared. ¿Está instalado y en el PATH?\n        Detalle:",
    err.message
  );
});

cloudflared.on("close", (codigo) => {
  console.log(`\n[tunel] cloudflared se cerró (código ${codigo}). La URL dejó de funcionar.`);
  process.exit(codigo ?? 0);
});

// Ctrl+C cierra el túnel de forma ordenada.
for (const senal of ["SIGINT", "SIGTERM"]) {
  process.on(senal, () => {
    console.log("\n[tunel] Cerrando el túnel...");
    cloudflared.kill();
  });
}
