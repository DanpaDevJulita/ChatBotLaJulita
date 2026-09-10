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
  const activo = campoCheckbox(p.activo !== false);

  [nombre, descripcion, semana, finde, puente, activo].forEach((el) => {
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
