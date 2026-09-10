import "dotenv/config";
import { createApp } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(PORT, () => {
  console.log(`Bot La Julita escuchando en http://localhost:${PORT}`);
  console.log(`Webhook de WhatsApp: POST http://localhost:${PORT}/webhooks/whatsapp`);
});
