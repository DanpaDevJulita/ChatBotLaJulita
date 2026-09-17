/**
 * Script para enviar mensaje de corrección al cliente
 * Uso: npx tsx enviar-correccion.ts
 */

import "dotenv/config";
import { whatsappYcloudAdapter } from "./src/channels/whatsapp-ycloud/adapter.js";
import { enviarSeguro } from "./src/core/pipeline/enviar.js";

const numero = "+573144405681";
const mensaje = `Ajusto mi respuesta: para esa fecha no hay disponibilidad para 1 persona. Pero mira estas opciones que sí tengo libres: lunes 21, martes 22, miércoles 23, jueves 24 de septiembre. ¿Te gustaría conocer alguno de esos días?`;

async function enviarCorreccion() {
  try {
    const resultado = await enviarSeguro(whatsappYcloudAdapter, numero, mensaje, "correccion-manual");
    
    if (resultado) {
      console.log(`✅ Mensaje enviado correctamente a ${numero}`);
    } else {
      console.log(`❌ Falló el envío a ${numero}`);
    }
  } catch (err) {
    console.error("Error:", err);
  }
  process.exit(0);
}

enviarCorreccion();
