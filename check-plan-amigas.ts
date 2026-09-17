import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or keys");
  console.error("URL:", process.env.SUPABASE_URL);
  console.error("SERVICE_ROLE_KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "✓" : "✗");
  console.error("ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "✓" : "✗");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log("Consultando plan AMIGAS...\n");

  // Buscar el plan AMIGAS
  const { data, error } = await supabase
    .from("planes")
    .select("id, nombre, link_video, descripcion")
    .ilike("nombre", "%amigas%");

  if (error) {
    console.error("Error:", error);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log("No se encontró ningún plan con 'amigas' en el nombre");
    process.exit(1);
  }

  console.log("✅ Planes encontrados con 'amigas':\n");
  for (const plan of data) {
    console.log(`ID: ${plan.id}`);
    console.log(`Nombre: ${plan.nombre}`);
    
    if (!plan.link_video) {
      console.log(`❌ link_video: NULL o vacío — ¡ESTE ES EL PROBLEMA!`);
      console.log(`   → Sin link_video, la herramienta no puede enviar el video\n`);
    } else {
      const esYoutube = /youtube\.com|youtu\.be/i.test(plan.link_video);
      console.log(`link_video: ${plan.link_video.substring(0, 100)}...`);
      if (esYoutube) {
        console.log(`⚠️  Es un link de YouTube → se envía COMO LINK de texto, no como video nativo`);
      } else {
        console.log(`✅ Es un link directo (.mp4) → se DEBERÍA enviar como video nativo de WhatsApp`);
      }
    }
  }
}

main();
