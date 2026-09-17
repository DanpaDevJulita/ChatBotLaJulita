// Panel de administración de La Julita — JS plano, sin build ni frameworks (a propósito,
// para que sea fácil de leer y tocar). Todo pasa por fetch() a /admin/api/*.

const api = {
  async get(url) {
    const res = await fetch(url);
    if (res.status === 401) return redirectToLogin();
    return res.json();
  },
  async send(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) return redirectToLogin();
    const data = await res.json().catch(() => ({ ok: res.ok }));
    if (!data.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  },
};

function redirectToLogin() {
  window.location.href = "/admin/login.html";
  return null;
}

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toast.hidden = true), 3000);
}

function money(n) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

// --- Sesión / arranque ---------------------------------------------------------------------
async function init() {
  const session = await api.get("/admin/api/session");
  if (!session || !session.isAdmin) return redirectToLogin();

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api.send("POST", "/admin/api/logout");
    redirectToLogin();
  });

  const estado = await api.get("/admin/api/estado");
  if (estado && !estado.supabaseConfigured) {
    document.getElementById("banner-supabase").hidden = false;
  }

  setupTabs();
  cargarPlanes();
  cargarAdicionales();
  cargarHorarios();
  cargarFechasBloqueadas();
  cargarFaq();
  cargarConversaciones();
  cargarPromociones();
  cargarPlantillasCarousel();
  cargarEnviosPromociones();
}

function setupTabs() {
  const botones = document.querySelectorAll("nav.tabs button");
  botones.forEach((btn) => {
    btn.addEventListener("click", () => {
      botones.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll("main .panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`panel-${btn.dataset.panel}`).classList.add("active");
    });
  });
}

// --- Planes ----------------------------------------------------------------------------------
async function cargarPlanes() {
  const planes = await api.get("/admin/api/planes");
  const tbody = document.getElementById("planes-body");
  tbody.innerHTML = "";
  (planes || []).forEach((p) => tbody.appendChild(filaPlan(p)));
}

// La tabla `planes` tiene TRES precios (entre semana / fin de semana / fin de semana con
// puente festivo) — no un solo "precio" — y no tiene `capacidad` ni `orden`. Este panel es la
// única forma en que el equipo actualiza precios, así que las columnas de acá tienen que ser
// exactamente las de la base.
function filaPlan(p) {
  const tr = document.createElement("tr");

  const nombre = campoTexto(p.nombre);
  const descripcion = campoTextarea(p.descripcion || "");
  const semana = campoNumero(p.precio_entre_semana ?? "");
  const finde = campoNumero(p.precio_fin_de_semana ?? "");
  const puente = campoNumero(p.precio_fin_de_semana_puente ?? "");
  const retailerId = campoTexto(p.retailer_id || "");
  const activo = campoCheckbox(p.activo !== false);

  [nombre, descripcion, semana, finde, puente, retailerId, activo].forEach((el) => {
    const td = document.createElement("td");
    td.appendChild(el);
    tr.appendChild(td);
  });

  const tdAcciones = document.createElement("td");
  tdAcciones.className = "row-actions";
  tdAcciones.appendChild(
    botonAccion("Guardar", "btn primary", async () => {
      try {
        await api.send("PUT", "/admin/api/planes", {
          id: p.id,
          nombre: nombre.value,
          descripcion: descripcion.value,
          precio_entre_semana: semana.value === "" ? null : Number(semana.value),
          precio_fin_de_semana: finde.value === "" ? null : Number(finde.value),
          precio_fin_de_semana_puente: puente.value === "" ? null : Number(puente.value),
          retailer_id: retailerId.value || null,
          activo: activo.checked,
        });
        showToast("Plan guardado");
        cargarPlanes();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tdAcciones.appendChild(
    botonAccion("Borrar", "btn danger", async () => {
      if (!confirm(`¿Borrar el plan "${p.nombre}"?`)) return;
      try {
        await api.send("DELETE", `/admin/api/planes/${p.id}`);
        showToast("Plan borrado");
        cargarPlanes();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tr.appendChild(tdAcciones);
  return tr;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("planes-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await api.send("PUT", "/admin/api/planes", {
        nombre: form.get("nombre"),
        precio_entre_semana: form.get("precio_entre_semana") ? Number(form.get("precio_entre_semana")) : null,
        precio_fin_de_semana: form.get("precio_fin_de_semana") ? Number(form.get("precio_fin_de_semana")) : null,
        precio_fin_de_semana_puente: form.get("precio_fin_de_semana_puente")
          ? Number(form.get("precio_fin_de_semana_puente"))
          : null,
        retailer_id: form.get("retailer_id") || null,
        descripcion: form.get("descripcion"),
        activo: true,
      });
      e.target.reset();
      showToast("Plan agregado");
      cargarPlanes();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Adicionales ------------------------------------------------------------------------------
// En `adicionales` la columna de activo/inactivo se llama `estado` (no `activo`, como en
// planes) y hay un `tipo_adicional_id` obligatorio. No hay columna `orden`.
let tiposAdicional = [];

async function cargarAdicionales() {
  const [items, tipos] = await Promise.all([
    api.get("/admin/api/adicionales"),
    api.get("/admin/api/tipo-adicional"),
  ]);
  tiposAdicional = tipos || [];
  const selectNuevo = document.getElementById("adicional-tipo-nuevo");
  if (selectNuevo) {
    selectNuevo.innerHTML = "";
    tiposAdicional.forEach((t) => selectNuevo.appendChild(new Option(t.nombre, t.id)));
  }
  const tbody = document.getElementById("adicionales-body");
  tbody.innerHTML = "";
  (items || []).forEach((a) => tbody.appendChild(filaAdicional(a)));
}

function campoTipoAdicional(valor) {
  const select = document.createElement("select");
  tiposAdicional.forEach((t) => select.appendChild(new Option(t.nombre, t.id)));
  if (valor != null) select.value = String(valor);
  return select;
}

function filaAdicional(a) {
  const tr = document.createElement("tr");
  const nombre = campoTexto(a.nombre);
  const descripcion = campoTextarea(a.descripcion || "");
  const precio = campoNumero(a.precio ?? "");
  const tipo = campoTipoAdicional(a.tipo_adicional_id);
  const activo = campoCheckbox(a.estado !== false);

  [nombre, descripcion, precio, tipo, activo].forEach((el) => {
    const td = document.createElement("td");
    td.appendChild(el);
    tr.appendChild(td);
  });

  const tdAcciones = document.createElement("td");
  tdAcciones.className = "row-actions";
  tdAcciones.appendChild(
    botonAccion("Guardar", "btn primary", async () => {
      try {
        await api.send("PUT", "/admin/api/adicionales", {
          id: a.id,
          nombre: nombre.value,
          descripcion: descripcion.value,
          precio: precio.value === "" ? null : Number(precio.value),
          tipo_adicional_id: Number(tipo.value),
          estado: activo.checked,
        });
        showToast("Adicional guardado");
        cargarAdicionales();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tdAcciones.appendChild(
    botonAccion("Borrar", "btn danger", async () => {
      if (!confirm(`¿Borrar "${a.nombre}"?`)) return;
      try {
        await api.send("DELETE", `/admin/api/adicionales/${a.id}`);
        showToast("Adicional borrado");
        cargarAdicionales();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tr.appendChild(tdAcciones);
  return tr;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("adicionales-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await api.send("PUT", "/admin/api/adicionales", {
        nombre: form.get("nombre"),
        precio: form.get("precio") ? Number(form.get("precio")) : null,
        tipo_adicional_id: Number(form.get("tipo_adicional_id")),
        descripcion: form.get("descripcion"),
        estado: true,
      });
      e.target.reset();
      showToast("Adicional agregado");
      cargarAdicionales();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Horarios y fechas bloqueadas --------------------------------------------------------------
async function cargarHorarios() {
  const config = await api.get("/admin/api/configuracion");
  document.getElementById("checkin-input").value = (config && config.checkin) || "";
  document.getElementById("checkout-input").value = (config && config.checkout) || "";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("guardar-horarios").addEventListener("click", async () => {
    try {
      await api.send("PUT", "/admin/api/configuracion/checkin", {
        valor: document.getElementById("checkin-input").value,
      });
      await api.send("PUT", "/admin/api/configuracion/checkout", {
        valor: document.getElementById("checkout-input").value,
      });
      showToast("Horarios guardados");
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById("fechas-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await api.send("POST", "/admin/api/fechas-bloqueadas", {
        fecha: form.get("fecha"),
        motivo: form.get("motivo"),
      });
      e.target.reset();
      showToast("Fecha bloqueada");
      cargarFechasBloqueadas();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function cargarFechasBloqueadas() {
  const fechas = await api.get("/admin/api/fechas-bloqueadas");
  const tbody = document.getElementById("fechas-body");
  tbody.innerHTML = "";
  (fechas || []).forEach((f) => {
    const tr = document.createElement("tr");
    const tdFecha = document.createElement("td");
    tdFecha.textContent = f.fecha;
    const tdMotivo = document.createElement("td");
    tdMotivo.textContent = f.motivo || "";
    const tdAcciones = document.createElement("td");
    tdAcciones.appendChild(
      botonAccion("Quitar", "btn danger", async () => {
        try {
          await api.send("DELETE", `/admin/api/fechas-bloqueadas/${f.id}`);
          showToast("Fecha desbloqueada");
          cargarFechasBloqueadas();
        } catch (err) {
          showToast(err.message, true);
        }
      })
    );
    tr.append(tdFecha, tdMotivo, tdAcciones);
    tbody.appendChild(tr);
  });
}

// --- FAQ -------------------------------------------------------------------------------------
async function cargarFaq() {
  const items = await api.get("/admin/api/faq");
  const tbody = document.getElementById("faq-body");
  tbody.innerHTML = "";
  (items || []).forEach((f) => tbody.appendChild(filaFaq(f)));
}

function filaFaq(f) {
  const tr = document.createElement("tr");
  const tdTema = document.createElement("td");
  tdTema.textContent = f.tema; // el tema no se edita una vez creado — evita romper preguntas ya usadas
  const pregunta = campoTexto(f.pregunta_ejemplo || "");
  const respuesta = campoTextarea(f.respuesta || "");

  tr.appendChild(tdTema);
  [pregunta, respuesta].forEach((el) => {
    const td = document.createElement("td");
    td.appendChild(el);
    tr.appendChild(td);
  });

  const tdAcciones = document.createElement("td");
  tdAcciones.className = "row-actions";
  tdAcciones.appendChild(
    botonAccion("Guardar", "btn primary", async () => {
      try {
        await api.send("PUT", `/admin/api/faq/${encodeURIComponent(f.tema)}`, {
          pregunta_ejemplo: pregunta.value,
          respuesta: respuesta.value,
        });
        showToast("Pregunta guardada");
        cargarFaq();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tdAcciones.appendChild(
    botonAccion("Borrar", "btn danger", async () => {
      if (!confirm(`¿Borrar la pregunta "${f.tema}"?`)) return;
      try {
        await api.send("DELETE", `/admin/api/faq/${encodeURIComponent(f.tema)}`);
        showToast("Pregunta borrada");
        cargarFaq();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tr.appendChild(tdAcciones);
  return tr;
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("faq-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const tema = String(form.get("tema") || "").trim();
    if (!/^[a-z0-9_]+$/.test(tema)) {
      showToast("El tema solo puede tener letras minúsculas, números y guión bajo", true);
      return;
    }
    try {
      await api.send("PUT", `/admin/api/faq/${encodeURIComponent(tema)}`, {
        pregunta_ejemplo: form.get("pregunta_ejemplo"),
        respuesta: form.get("respuesta"),
      });
      e.target.reset();
      showToast("Pregunta agregada");
      cargarFaq();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Conversaciones ----------------------------------------------------------------------------
async function cargarConversaciones() {
  const conversaciones = await api.get("/admin/api/conversaciones");
  const list = document.getElementById("conv-list");
  list.innerHTML = "";
  if (!conversaciones || conversaciones.length === 0) {
    list.innerHTML = '<div class="empty-state">Todavía no hay conversaciones.</div>';
    return;
  }
  conversaciones.forEach((c) => {
    const btn = document.createElement("button");
    const tel = document.createElement("div");
    tel.className = "telefono";
    tel.textContent = `${c.external_id} (${c.canal})`;
    const preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = c.ultimo_mensaje;
    btn.append(tel, preview);
    btn.addEventListener("click", () => {
      list.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      mostrarConversacion(c.canal, c.external_id);
    });
    list.appendChild(btn);
  });
}

async function mostrarConversacion(canal, externalId) {
  const mensajes = await api.get(`/admin/api/conversaciones/${encodeURIComponent(canal)}/${encodeURIComponent(externalId)}`);
  const view = document.getElementById("chat-view");
  view.innerHTML = "";
  (mensajes || []).forEach((m) => {
    const div = document.createElement("div");
    div.className = `chat-msg ${m.role === "assistant" ? "assistant" : "user"}`;
    const texto = document.createElement("div");
    texto.textContent = m.content;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = new Date(m.created_at).toLocaleString("es-CO");
    div.append(texto, meta);
    view.appendChild(div);
  });
  if (!mensajes || mensajes.length === 0) {
    view.innerHTML = '<div class="empty-state">Sin mensajes.</div>';
  }
}

// --- Promociones (carousel de WhatsApp) -----------------------------------------------------
// [2026-09-15] Ver REFERENCIA-MODULO-PROMOCIONES.md. Esto NO manda nada solo: cada tarjeta se
// guarda acá, y el envío real solo pasa cuando alguien aprieta "Enviar campaña" más abajo.
async function cargarPromociones() {
  const items = await api.get("/admin/api/promociones");
  const tbody = document.getElementById("promociones-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  (items || []).forEach((p) => tbody.appendChild(filaPromocion(p)));
}

function filaPromocion(p) {
  const tr = document.createElement("tr");
  const nombre = campoTexto(p.nombre);
  const texto = campoTextarea(p.texto_tarjeta || "");
  const imagen = campoTexto(p.imagen_url || "");
  const botonUrl = campoTexto(p.boton_url || "");
  const orden = campoNumero(p.orden ?? 0);
  const activa = campoCheckbox(p.activa !== false);

  [nombre, texto, imagen, botonUrl, orden, activa].forEach((el) => {
    const td = document.createElement("td");
    td.appendChild(el);
    tr.appendChild(td);
  });

  const tdAcciones = document.createElement("td");
  tdAcciones.className = "row-actions";
  tdAcciones.appendChild(
    botonAccion("Guardar", "btn primary", async () => {
      try {
        await api.send("PUT", "/admin/api/promociones", {
          id: p.id,
          nombre: nombre.value,
          texto_tarjeta: texto.value,
          imagen_url: imagen.value,
          boton_url: botonUrl.value || null,
          orden: orden.value === "" ? 0 : Number(orden.value),
          activa: activa.checked,
        });
        showToast("Promoción guardada");
        cargarPromociones();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tdAcciones.appendChild(
    botonAccion("Borrar", "btn danger", async () => {
      if (!confirm(`¿Borrar la promoción "${p.nombre}"?`)) return;
      try {
        await api.send("DELETE", `/admin/api/promociones/${p.id}`);
        showToast("Promoción borrada");
        cargarPromociones();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tr.appendChild(tdAcciones);
  return tr;
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("promociones-add-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    try {
      await api.send("PUT", "/admin/api/promociones", {
        nombre: data.get("nombre"),
        texto_tarjeta: data.get("texto_tarjeta"),
        imagen_url: data.get("imagen_url"),
        boton_url: data.get("boton_url") || null,
        orden: data.get("orden") ? Number(data.get("orden")) : 0,
        activa: true,
      });
      e.target.reset();
      showToast("Promoción agregada");
      cargarPromociones();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Plantillas de carousel (registro de lo que ya aprobó Meta) -----------------------------
let plantillasCarouselCache = [];

async function cargarPlantillasCarousel() {
  const items = await api.get("/admin/api/plantillas-carousel");
  plantillasCarouselCache = items || [];
  const tbody = document.getElementById("plantillas-carousel-body");
  if (tbody) {
    tbody.innerHTML = "";
    plantillasCarouselCache.forEach((p) => tbody.appendChild(filaPlantillaCarousel(p)));
  }
  const select = document.getElementById("promo-broadcast-plantilla");
  if (select) {
    const actual = select.value;
    select.innerHTML = "";
    plantillasCarouselCache
      .filter((p) => p.activa !== false)
      .forEach((p) => select.appendChild(new Option(`${p.nombre_plantilla} (${p.cantidad_tarjetas} tarjetas)`, p.nombre_plantilla)));
    if (actual) select.value = actual;
  }
}

function filaPlantillaCarousel(p) {
  const tr = document.createElement("tr");
  const nombre = campoTexto(p.nombre_plantilla);
  const cantidad = campoNumero(p.cantidad_tarjetas);
  const idioma = campoTexto(p.idioma || "es");
  const tieneBoton = document.createElement("select");
  tieneBoton.appendChild(new Option("Sí", "true"));
  tieneBoton.appendChild(new Option("No", "false"));
  tieneBoton.value = p.incluye_boton_url === false ? "false" : "true";
  const activa = campoCheckbox(p.activa !== false);

  [nombre, cantidad, idioma, tieneBoton, activa].forEach((el) => {
    const td = document.createElement("td");
    td.appendChild(el);
    tr.appendChild(td);
  });

  const tdAcciones = document.createElement("td");
  tdAcciones.className = "row-actions";
  tdAcciones.appendChild(
    botonAccion("Guardar", "btn primary", async () => {
      try {
        await api.send("PUT", "/admin/api/plantillas-carousel", {
          id: p.id,
          nombre_plantilla: nombre.value,
          cantidad_tarjetas: Number(cantidad.value),
          idioma: idioma.value,
          incluye_boton_url: tieneBoton.value === "true",
          activa: activa.checked,
        });
        showToast("Plantilla guardada");
        cargarPlantillasCarousel();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tdAcciones.appendChild(
    botonAccion("Borrar", "btn danger", async () => {
      if (!confirm(`¿Borrar la plantilla "${p.nombre_plantilla}"?`)) return;
      try {
        await api.send("DELETE", `/admin/api/plantillas-carousel/${p.id}`);
        showToast("Plantilla borrada");
        cargarPlantillasCarousel();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  tr.appendChild(tdAcciones);
  return tr;
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("plantillas-carousel-add-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    try {
      await api.send("PUT", "/admin/api/plantillas-carousel", {
        nombre_plantilla: data.get("nombre_plantilla"),
        cantidad_tarjetas: Number(data.get("cantidad_tarjetas")),
        idioma: data.get("idioma") || "es",
        incluye_boton_url: data.get("incluye_boton_url") === "true",
        activa: true,
      });
      e.target.reset();
      showToast("Plantilla registrada");
      cargarPlantillasCarousel();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Enviar campaña de promociones -----------------------------------------------------------
function destinatariosDelTextarea() {
  const texto = document.getElementById("promo-broadcast-destinatarios").value;
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

document.addEventListener("DOMContentLoaded", () => {
  const btnRevisar = document.getElementById("promo-broadcast-revisar");
  const btnEnviar = document.getElementById("promo-broadcast-enviar");
  const resultado = document.getElementById("promo-broadcast-resultado");
  if (!btnRevisar || !btnEnviar) return;

  btnRevisar.addEventListener("click", async () => {
    const plantilla_nombre = document.getElementById("promo-broadcast-plantilla").value;
    resultado.textContent = "Revisando...";
    try {
      const r = await api.send("POST", "/admin/api/promociones/vista-previa", { plantilla_nombre });
      resultado.textContent =
        `✅ Todo listo: la plantilla "${r.plantilla}" (${r.cantidadTarjetas} tarjetas) calza con las promociones activas:\n` +
        r.promociones.map((p) => `  • ${p.nombre}`).join("\n");
    } catch (err) {
      resultado.textContent = `❌ ${err.message}`;
    }
  });

  btnEnviar.addEventListener("click", async () => {
    const plantilla_nombre = document.getElementById("promo-broadcast-plantilla").value;
    const destinatarios = destinatariosDelTextarea();
    if (destinatarios.length === 0) {
      showToast("Pega al menos un número de destino", true);
      return;
    }
    if (!confirm(`¿Enviar la campaña "${plantilla_nombre}" a ${destinatarios.length} número(s)?`)) return;
    resultado.textContent = "Enviando...";
    try {
      const r = await api.send("POST", "/admin/api/promociones/enviar", { plantilla_nombre, destinatarios });
      const d = r.data;
      resultado.textContent =
        `Campaña enviada: ${d.exitosos} exitoso(s), ${d.fallidos} fallido(s) de ${d.resultados.length}.\n` +
        d.resultados
          .filter((x) => !x.ok)
          .map((x) => `  ❌ ${x.destinatario}: ${x.error}`)
          .join("\n");
      showToast("Campaña enviada");
      cargarEnviosPromociones();
    } catch (err) {
      resultado.textContent = `❌ ${err.message}`;
      showToast(err.message, true);
    }
  });
});

async function cargarEnviosPromociones() {
  const envios = await api.get("/admin/api/promociones/envios");
  const tbody = document.getElementById("promociones-envios-body");
  if (!tbody) return;
  tbody.innerHTML = "";
  (envios || []).forEach((e) => {
    const tr = document.createElement("tr");
    const fecha = new Date(e.creado_en).toLocaleString("es-CO");
    tr.innerHTML = `<td>${fecha}</td><td>${e.plantilla_nombre}</td><td>${e.total_destinatarios}</td><td>${e.total_exitosos}</td><td>${e.total_fallidos}</td>`;
    tbody.appendChild(tr);
  });
}

// --- Helpers de campos de tabla ------------------------------------------------------------
function campoTexto(valor) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = valor;
  return input;
}
function campoTextarea(valor) {
  const textarea = document.createElement("textarea");
  textarea.value = valor;
  return textarea;
}
function campoNumero(valor) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = valor;
  return input;
}
function campoCheckbox(marcado) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = marcado;
  return input;
}
function botonAccion(texto, clase, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = clase;
  btn.textContent = texto;
  btn.addEventListener("click", onClick);
  return btn;
}

init();
