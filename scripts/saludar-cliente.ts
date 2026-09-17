import "dotenv/config";
import { sendTextMessage } from "../src/channels/whatsapp-ycloud/client.js";

async function main() {
  const telefono = "+573144405681";
  const saludo = `¡Hola! 👋

Soy el bot de La Julita Glamping. Te doy la bienvenida a nuestro chat.

Te ayudaré con:
✅ Información sobre nuestros planes
✅ Precios y disponibilidad
✅ Reservas
✅ Cualquier otra consulta

¿En qué puedo ayudarte hoy?`;

  console.log(`\n📱 Enviando saludo a ${telefono}...\n`);

  try {
    const resultado = await sendTextMessage(telefono, saludo);
    console.log("✅ ¡Saludo enviado exitosamente!");
    console.log("   ID del mensaje:", resultado.id);
  } catch (err) {
    console.error("❌ Error al enviar saludo:", (err as Error).message);
  }
}

main();
