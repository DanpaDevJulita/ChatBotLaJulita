import { Router } from "express";
import { requireAdmin, login, logout, sessionStatus } from "./auth.js";
import * as faqRepo from "../../core/db/faqRepo.js";
import * as politicasRepo from "../../core/db/politicasRepo.js";
import * as catalogoRepo from "../../core/db/catalogoRepo.js";
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
