import { Router } from "express";
import { requireAdmin, login, logout, sessionStatus } from "./auth.js";
import * as faqRepo from "../../core/db/faqRepo.js";
import * as politicasRepo from "../../core/db/politicasRepo.js";
import * as catalogoRepo from "../../core/db/catalogoRepo.js";
import * as promocionesRepo from "../../core/db/promocionesRepo.js";
import { enviarPromocionesCarousel, armarTarjetasPromociones } from "../../core/marketing/promocionesBroadcast.js";
import * as mensajesRepo from "../../core/db/mensajesRepo.js";
import { supabaseConfigured } from "../../core/db/supabase.js";

export const adminApiRouter = Router();

// --- Login / sesión (sin auth, obviamente) ------------------------------------------------
adminApiRouter.post("/login", login);
adminApiRouter.post("/logout", logout);
adminApiRouter.get("/session", sessionStatus);

// A partir de aquí, todo requiere haber iniciado sesión.
adminApiRouter.use(requireAdmin);

adminApiRouter.get("/estado", (_req, res) => {
  res.json({ ok: true, supabaseConfigured });
});

// --- FAQ ------------------------------------------------------------------------------------
adminApiRouter.get("/faq", async (_req, res) => {
  res.json(await faqRepo.listFaq(true));
});

adminApiRouter.put("/faq/:tema", async (req, res) => {
  try {
    await faqRepo.upsertFaq({
      tema: req.params.tema,
      pregunta_ejemplo: typeof req.body?.pregunta_ejemplo === "string" ? req.body.pregunta_ejemplo : null,
      respuesta: String(req.body?.respuesta ?? ""),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.delete("/faq/:tema", async (req, res) => {
  try {
    await faqRepo.deleteFaq(req.params.tema);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// --- Políticas -------------------------------------------------------------------------------
// [2026-09-13] Los términos y condiciones del glamping viven en la tabla `politicas` y el bot
// los manda TAL CUAL (ver sql/politicas.sql). Se editan desde acá para que cambiar un plazo o un
// monto no necesite tocar código ni volver a desplegar: el bot los relee a los 30 segundos.
//
// OJO: lo que se guarde acá es lo que el cliente va a leer, palabra por palabra. Es WhatsApp, así
// que la negrita va con UN asterisco (*así*), no con dos.
adminApiRouter.get("/politicas", async (_req, res) => {
  res.json(await politicasRepo.listPoliticas(true));
});

adminApiRouter.put("/politicas/:clave", async (req, res) => {
  try {
    const contenido = String(req.body?.contenido ?? "").trim();
    // Una política vacía es peor que ninguna: el bot dejaría de mandarla sin que nadie se entere.
    // Para desactivarla está `activo`, y para sacarla del todo está el DELETE de abajo.
    if (!contenido) {
      res.status(400).json({ ok: false, error: "El contenido no puede quedar vacío." });
      return;
    }
    await politicasRepo.upsertPolitica({
      clave: req.params.clave,
      titulo: typeof req.body?.titulo === "string" ? req.body.titulo : null,
      contenido,
      activo: req.body?.activo === undefined ? true : Boolean(req.body.activo),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.delete("/politicas/:clave", async (req, res) => {
  try {
    await politicasRepo.deletePolitica(req.params.clave);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// --- Planes ----------------------------------------------------------------------------------
/**
 * [2026-09-09] El panel mandaba `precio`, `capacidad` y `orden` — tres columnas que NO
 * existen en la tabla `planes` (el rediseño las cambió por tres precios según el día). Cada
 * "Guardar" del panel moría con 42703 y el equipo no podía actualizar precios, que es
 * justamente para lo que se hizo el panel. Se filtran las columnas acá también, así una
 * pantalla vieja en caché nunca vuelve a romper el guardado.
 */
function soloColumnasDePlan(body: any) {
  const numeroOnulo = (v: any) => (v === "" || v == null ? null : Number(v));
  const fila: Record<string, unknown> = {
    nombre: String(body?.nombre ?? "").trim(),
    descripcion: body?.descripcion ? String(body.descripcion) : null,
    precio_entre_semana: numeroOnulo(body?.precio_entre_semana),
    precio_fin_de_semana: numeroOnulo(body?.precio_fin_de_semana),
    precio_fin_de_semana_puente: numeroOnulo(body?.precio_fin_de_semana_puente),
    // [2026-09-14 → 2026-09-16] Video de este plan — ver sql/planes-link-video.sql. Vacío/no
    // enviado = null: el bot no manda ningún video para ese plan. Desde el 16/09, acá va de
    // preferencia la URL directa del archivo .mp4 (por ejemplo del bucket "planes-videos" de
    // Supabase Storage — ver sql/planes-videos-bucket.sql), no el link de la página de YouTube:
    // así el bot lo manda como video nativo de WhatsApp en vez de un link de texto.
    link_video: body?.link_video ? String(body.link_video).trim() : null,
    // [2026-09-15] SKU de este plan en el catálogo de Meta — ver sql/planes-retailer-id.sql y
    // REFERENCIA-CATALOGO-WHATSAPP.md. Vacío = el bot no lo incluye en el mensaje de catálogo.
    retailer_id: body?.retailer_id ? String(body.retailer_id).trim() : null,
    activo: body?.activo !== false,
  };
  if (body?.id != null && body.id !== "") fila.id = Number(body.id);
  if (Array.isArray(body?.domos_id)) fila.domos_id = body.domos_id.map(Number);
  if (!fila.nombre) throw new Error("El nombre del plan es obligatorio");
  return fila;
}

function soloColumnasDeAdicional(body: any) {
  const fila: Record<string, unknown> = {
    nombre: String(body?.nombre ?? "").trim(),
    descripcion: body?.descripcion ? String(body.descripcion) : null,
    precio: body?.precio === "" || body?.precio == null ? null : Number(body.precio),
    tipo_adicional_id: Number(body?.tipo_adicional_id),
    estado: body?.estado !== false,
  };
  if (body?.id != null && body.id !== "") fila.id = Number(body.id);
  if (!fila.nombre) throw new Error("El nombre del adicional es obligatorio");
  if (!Number.isFinite(fila.tipo_adicional_id as number)) throw new Error("Falta el tipo de adicional");
  return fila;
}

adminApiRouter.get("/planes", async (_req, res) => {
  res.json(await catalogoRepo.planesRepo.list());
});

adminApiRouter.get("/tipo-adicional", async (_req, res) => {
  res.json(await catalogoRepo.listTipoAdicional());
});

adminApiRouter.put("/planes", async (req, res) => {
  try {
    const guardado = await catalogoRepo.planesRepo.upsert(soloColumnasDePlan(req.body) as any);
    res.json({ ok: true, data: guardado });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.delete("/planes/:id", async (req, res) => {
  try {
    await catalogoRepo.planesRepo.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// --- Adicionales -------------------------------------------------------------------------------
adminApiRouter.get("/adicionales", async (_req, res) => {
  res.json(await catalogoRepo.adicionalesRepo.list());
});

adminApiRouter.put("/adicionales", async (req, res) => {
  try {
    const guardado = await catalogoRepo.adicionalesRepo.upsert(soloColumnasDeAdicional(req.body) as any);
    res.json({ ok: true, data: guardado });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.delete("/adicionales/:id", async (req, res) => {
  try {
    await catalogoRepo.adicionalesRepo.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// --- Configuración (horarios) + fechas bloqueadas ------------------------------------------
adminApiRouter.get("/configuracion", async (_req, res) => {
  res.json(await catalogoRepo.getConfiguracion());
});

adminApiRouter.put("/configuracion/:clave", async (req, res) => {
  try {
    await catalogoRepo.setConfiguracion(req.params.clave, String(req.body?.valor ?? ""));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.get("/fechas-bloqueadas", async (_req, res) => {
  res.json(await catalogoRepo.listFechasBloqueadas());
});

adminApiRouter.post("/fechas-bloqueadas", async (req, res) => {
  try {
    await catalogoRepo.addFechaBloqueada(String(req.body?.fecha ?? ""), req.body?.motivo);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.delete("/fechas-bloqueadas/:id", async (req, res) => {
  try {
    await catalogoRepo.removeFechaBloqueada(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// --- Monitor de conversaciones ---------------------------------------------------------------
adminApiRouter.get("/conversaciones", async (_req, res) => {
  res.json(await mensajesRepo.listConversaciones());
});

adminApiRouter.get("/conversaciones/:canal/:externalId", async (req, res) => {
  res.json(await mensajesRepo.listMensajes(req.params.canal, req.params.externalId));
});

// --- Promociones (carousel de WhatsApp) -----------------------------------------------------
// [2026-09-15] Ver REFERENCIA-MODULO-PROMOCIONES.md. El carrusel se manda SOLO desde acá (botón
// "Enviar campaña" más abajo) — nunca automático durante una conversación normal del bot.
function soloColumnasDePromocion(body: any) {
  const fila: Record<string, unknown> = {
    nombre: String(body?.nombre ?? "").trim(),
    texto_tarjeta: String(body?.texto_tarjeta ?? "").trim(),
    imagen_url: String(body?.imagen_url ?? "").trim(),
    boton_texto: body?.boton_texto ? String(body.boton_texto).trim() : "Quiero esta promo",
    boton_url: body?.boton_url ? String(body.boton_url).trim() : null,
    orden: body?.orden === "" || body?.orden == null ? 0 : Number(body.orden),
    activa: body?.activa !== false,
  };
  if (body?.id != null && body.id !== "") fila.id = Number(body.id);
  if (!fila.nombre) throw new Error("El nombre de la promoción es obligatorio");
  if (!fila.texto_tarjeta) throw new Error("El texto de la tarjeta es obligatorio");
  if ((fila.texto_tarjeta as string).length > 160) {
    throw new Error("El texto de la tarjeta no puede pasar de 160 caracteres (límite de WhatsApp)");
  }
  if (!fila.imagen_url) throw new Error("La foto de la promoción es obligatoria");
  return fila;
}

adminApiRouter.get("/promociones", async (_req, res) => {
  res.json(await promocionesRepo.promocionesRepo.list());
});

adminApiRouter.put("/promociones", async (req, res) => {
  try {
    const guardado = await promocionesRepo.promocionesRepo.upsert(soloColumnasDePromocion(req.body) as any);
    res.json({ ok: true, data: guardado });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.delete("/promociones/:id", async (req, res) => {
  try {
    await promocionesRepo.promocionesRepo.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// --- Plantillas de carousel (registro de lo que YA aprobó Meta) ----------------------------
function soloColumnasDePlantillaCarousel(body: any) {
  const fila: Record<string, unknown> = {
    nombre_plantilla: String(body?.nombre_plantilla ?? "").trim(),
    idioma: body?.idioma ? String(body.idioma).trim() : "es",
    cantidad_tarjetas: Number(body?.cantidad_tarjetas),
    incluye_boton_url: body?.incluye_boton_url !== false,
    activa: body?.activa !== false,
  };
  if (body?.id != null && body.id !== "") fila.id = Number(body.id);
  if (!fila.nombre_plantilla) throw new Error("El nombre de la plantilla es obligatorio");
  const cantidad = fila.cantidad_tarjetas as number;
  if (!Number.isFinite(cantidad) || cantidad < 2 || cantidad > 10) {
    throw new Error("La cantidad de tarjetas tiene que ser un número entre 2 y 10 (límite de WhatsApp)");
  }
  return fila;
}

adminApiRouter.get("/plantillas-carousel", async (_req, res) => {
  res.json(await promocionesRepo.plantillasCarouselRepo.list());
});

adminApiRouter.put("/plantillas-carousel", async (req, res) => {
  try {
    const guardado = await promocionesRepo.plantillasCarouselRepo.upsert(soloColumnasDePlantillaCarousel(req.body) as any);
    res.json({ ok: true, data: guardado });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.delete("/plantillas-carousel/:id", async (req, res) => {
  try {
    await promocionesRepo.plantillasCarouselRepo.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// --- Enviar campaña de promociones -----------------------------------------------------------
// Antes de mandar nada de verdad, el panel puede pedir esta "vista previa" para saber si lo que
// hay activo hoy calza con la plantilla elegida (mismo chequeo que hace el envío real, sin
// gastar ningún mensaje).
adminApiRouter.post("/promociones/vista-previa", async (req, res) => {
  try {
    const nombrePlantilla = String(req.body?.plantilla_nombre ?? "").trim();
    const { plantilla, promociones } = await armarTarjetasPromociones(nombrePlantilla);
    res.json({
      ok: true,
      plantilla: plantilla.nombre_plantilla,
      cantidadTarjetas: plantilla.cantidad_tarjetas,
      promociones: promociones.map((p) => ({ id: p.id, nombre: p.nombre })),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.post("/promociones/enviar", async (req, res) => {
  try {
    const nombrePlantilla = String(req.body?.plantilla_nombre ?? "").trim();
    const destinatarios = Array.isArray(req.body?.destinatarios) ? req.body.destinatarios.map(String) : [];
    const resultado = await enviarPromocionesCarousel(nombrePlantilla, destinatarios);
    res.json({ ok: true, data: resultado });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

adminApiRouter.get("/promociones/envios", async (_req, res) => {
  res.json(await promocionesRepo.listEnviosPromociones());
});
