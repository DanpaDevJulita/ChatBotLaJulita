// Test rápido: revisar qué devolvaría la herramienta para el plan amigas
import { planesRepo } from "./src/core/db/catalogoRepo.js";

async function main() {
  console.log("Buscando planes con 'amigas' en el nombre...\n");

  const todosLosPlanes = await planesRepo.list(true);
  const conAmigas = todosLosPlanes.filter(p => 
    (p.nombre ?? "").toLowerCase().includes("amigas")
  );

  if (conAmigas.length === 0) {
    console.log("❌ No se encontró ningún plan con 'amigas'");
    return;
  }

  for (const plan of conAmigas) {
    console.log(`📋 Plan ID ${plan.id}: ${plan.nombre}`);
    console.log(`   link_video: ${plan.link_video ? "✅ SÍ EXISTE" : "❌ NULL/VACÍO"}`);
    
    if (plan.link_video) {
      const esYoutube = /youtube\.com|youtu\.be/i.test(plan.link_video);
      console.log(`   URL: ${plan.link_video.substring(0, 80)}...`);
      console.log(`   Tipo: ${esYoutube ? "YouTube link (en texto)" : "Video nativo (debe enviarse como archivo)"}`);
      
      // Simular la lógica del handler
      const videoNativo = plan.link_video && !esYoutube ? plan.link_video : undefined;
      console.log(`   ¿Se envía videoUrl?: ${videoNativo ? "✅ SÍ" : "❌ NO"}\n`);
    } else {
      console.log(`   ¿Se envía videoUrl?: ❌ NO (link_video está vacío)\n`);
    }
  }
}

main().catch(console.error);
