import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* "Mantener sesión iniciada": la sesión va a localStorage (persistente) o a sessionStorage (se borra al cerrar). */
const REMEMBER_KEY = "kb_remember";
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const remember = () => safe(() => localStorage.getItem(REMEMBER_KEY) !== "0", true);
const setRemember = (v) => safe(() => localStorage.setItem(REMEMBER_KEY, v ? "1" : "0"));
const authStorage = {
  getItem: (k) => safe(() => localStorage.getItem(k) ?? sessionStorage.getItem(k), null),
  setItem: (k, v) => safe(() => {
    const [on, off] = remember() ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
    on.setItem(k, v); off.removeItem(k);
  }),
  removeItem: (k) => safe(() => { localStorage.removeItem(k); sessionStorage.removeItem(k); })
};

const sb = createClient(
  "https://avrblfgwhofyzaceozew.supabase.co",
  "sb_publishable_x0nCCmOIH81eaQn5WrbZLg_sx0itqFb",
  { auth: { storage: authStorage } }
);

const app = document.getElementById("app");

const state = {
  recovery: /type=recovery/.test(location.hash),
  cabina: null,
  session: null,
  name: "",
  view: "cargando",
  notice: null,
  plans: [],
  ents: [],
  exams: [],
  study: null,
  simCfg: null,
  sim: null
};

/* ---------- utilidades ---------- */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const KNOWN_ERRORS = new Set([
  "Cupón no válido",
  "Este usuario ya usó su prueba gratis",
  "Este usuario ya tiene un plan activo",
  "Sin acceso a este examen",
  "Intento no válido o ya finalizado",
  "Intento no válido",
  "Opción inválida",
  "La pregunta no pertenece al intento",
  "El banco no tiene preguntas",
  "Cantidad inválida",
  "Asignaturas no válidas",
  "No autorizado",
  "Plan no disponible",
  "Ya tienes este plan",
  "Debes iniciar sesión"
]);

function errorText(err) {
  const msg = (err && err.message) || "";
  if (KNOWN_ERRORS.has(msg)) return msg;
  const m = msg.toLowerCase();
  if (m.includes("invalid login credentials")) return "Correo o contraseña incorrectos.";
  if (m.includes("already registered") || m.includes("already been registered")) return "Ese correo ya tiene una cuenta. Prueba con Ingresar.";
  if (m.includes("password") && (m.includes("characters") || m.includes("weak") || m.includes("pwned"))) return "Elige una contraseña más segura, de al menos 8 caracteres.";
  if (m.includes("valid email") || m.includes("invalid email")) return "Escribe un correo válido.";
  if (m.includes("rate limit") || m.includes("too many")) return "Demasiados intentos. Espera un momento y vuelve a probar.";
  if (m.includes("email not confirmed")) return "Debes confirmar tu correo antes de ingresar.";
  return "No se pudo completar la acción. Intenta de nuevo.";
}

function fmtPrice(amount, currency) {
  if (amount == null) return "Precio por definir";
  try {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: currency || "CLP", maximumFractionDigits: 0 }).format(Number(amount));
  } catch {
    return amount + " " + (currency || "");
  }
}

const TRIAL = "prueba-gratis";
const vigente = (e) => e.status === "active" && (!e.expires_at || new Date(e.expires_at) > new Date());
const activeSlugs = () => new Set(state.ents.filter((e) => vigente(e) && e.plans.slug !== TRIAL).map((e) => e.plans.slug));
const hasActive = () => state.ents.some(vigente);
const trialEnt = () => state.ents.find((e) => e.plans.slug === TRIAL && vigente(e));
const trialVencida = () => state.ents.some((e) => e.plans.slug === TRIAL && e.expires_at && new Date(e.expires_at) <= new Date());
let trialTimer = null;
function armTrialTimer() {
  clearTimeout(trialTimer); trialTimer = null;
  const t = trialEnt();
  if (!t || !t.expires_at) return;
  const ms = new Date(t.expires_at) - Date.now() + 1500;
  if (ms > 0 && ms < 2147483000) trialTimer = setTimeout(() => { if (state.session) loadAccount(state.session); }, ms);
}
function tiempoRestante(iso) {
  const min = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
  const h24 = Math.floor(min / 60), m = min % 60;
  return h24 > 0 ? h24 + " h " + m + " min" : m + " min";
}
const pendingEnt = () => state.ents.find((e) => e.status === "pending");
const plural = (n, uno, otros) => n + " " + (n === 1 ? uno : otros);

function setNotice(type, text) {
  state.notice = text ? { type, text } : null;
}

function go(view, notice) {
  state.view = view;
  state.menu = false;
  state.notice = notice || null;
  render();
  window.scrollTo(0, 0);
}

/* ---------- datos ---------- */

async function refreshEnts() {
  const { data } = await sb.from("entitlements").select("status, expires_at, plans(slug,name)");
  state.ents = (data || []).filter((e) => e.plans);
}

async function loadExams() {
  const { data, error } = await sb.rpc("exam_catalog");
  if (error || !Array.isArray(data)) { state.exams = []; return false; }
  state.exams = data.map((e) => ({ ...e, total: Number(e.total) || 0, topics: e.topics || [] }));
  return true;
}

async function loadQuestions(examId, ids, topics) {
  let q = sb.from("questions")
    .select("id,statement,topic,position,created_at,figures,options(id,label,text)")
    .eq("exam_id", examId);
  if (ids) q = q.in("id", ids);
  if (topics && topics.length) q = q.in("topic", topics);
  q = q.order("position", { nullsFirst: false }).order("created_at");
  const { data, error } = await q;
  if (error) throw error;
  const list = (data || []).map((r) => ({
    ...r,
    options: (r.options || []).slice().sort((a, b) => a.label.localeCompare(b.label))
  }));
  if (ids) {
    const orden = new Map(ids.map((id, i) => [id, i]));
    list.sort((a, b) => orden.get(a.id) - orden.get(b.id));
  }
  return list;
}

const PAGO = (() => { const m = /[?&]pago=(ok|pendiente|error)/.exec(location.search); return m ? m[1] : null; })();
if (PAGO) safe(() => history.replaceState(null, "", location.pathname));
let pagoPendiente = PAGO;

/* ---------- sesión única y dispositivos ---------- */

const deviceId = () => {
  let id = safe(() => localStorage.getItem("pp_device"), null);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    safe(() => localStorage.setItem("pp_device", id));
  }
  return id;
};
function deviceLabel() {
  const ua = navigator.userAgent;
  const so = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Otro";
  const nav = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return nav + " · " + so;
}
const sessionIdOf = (session) => {
  try { return JSON.parse(atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).session_id || null; } catch { return null; }
};
let expulsado = false;
async function syncSession(claim) {
  const { data, error } = await sb.rpc("session_sync", { p_device: deviceId(), p_label: deviceLabel(), p_claim: !!claim });
  if (error) return null;
  return data === true;
}
async function expulsar() {
  if (expulsado) return;
  expulsado = true;
  await sb.auth.signOut();
}

let presenceTimer = null;
function startPresence(on) {
  clearInterval(presenceTimer); presenceTimer = null;
  if (startPresence.off) { startPresence.off(); startPresence.off = null; }
  if (!on) return;
  const ping = async () => {
    if (document.visibilityState !== "visible") return;
    sb.rpc("touch_presence").then(() => {}, () => {});
    if (await syncSession(false) === false) expulsar();
  };
  presenceTimer = setInterval(ping, 60000);
  document.addEventListener("visibilitychange", ping);
  startPresence.off = () => document.removeEventListener("visibilitychange", ping);
}

let loadSeq = 0;
async function loadAccount(session) {
  const mine = ++loadSeq;
  state.session = session;
  if (state.recovery && session) { go("recuperar"); return; }
  if (state.recovery && !session) state.recovery = false;
  if (!session) startPresence(false);
  if (!session) {
    state.name = ""; state.ents = []; state.exams = []; state.study = null; state.sim = null; state.simCfg = null; state.studyCfg = null; state.isAdmin = false; state.reports = null; state.coupon = null;
    const kick = expulsado; expulsado = false;
    go("visitante", kick ? { type: "warn", text: "Tu cuenta se abrió en otro dispositivo, por eso cerramos esta sesión. Solo se permite una sesión activa por cuenta." } : null);
    return;
  }
  state.view = "cargando";
  render();
  expulsado = false;
  {
    const sid = sessionIdOf(session);
    const nuevo = sid && safe(() => authStorage.getItem("pp_sid"), null) !== sid;
    const ok = await syncSession(nuevo);
    if (mine !== loadSeq) return;
    if (ok === false) { expulsado = true; await sb.auth.signOut(); return; }
    if (sid) safe(() => authStorage.setItem("pp_sid", sid));
    startPresence(true);
  }
  const user = session.user;
  state.name = (user.user_metadata && user.user_metadata.display_name) || (user.email || "").split("@")[0];
  try {
    const catalogo = loadExams();
    const [prof, ents, plans, adm] = await Promise.all([
      sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
      sb.from("entitlements").select("status, expires_at, plans(slug,name)"),
      sb.from("plans")
        .select("slug,name,description,price_amount,currency,upgrade_from_plan_id,upgrade_price_amount,sort_order")
        .order("sort_order"),
      sb.rpc("is_admin")
    ]);
    if (mine !== loadSeq) return;
    if (prof.data && prof.data.display_name) state.name = prof.data.display_name;
    state.ents = (ents.data || []).filter((e) => e.plans);
    state.plans = (plans.data || []).filter((p) => p.slug !== TRIAL);
    state.isAdmin = adm.data === true;
    let aviso = null;
    if (pagoPendiente) {
      const p = pagoPendiente; pagoPendiente = null;
      if (p === "ok") {
        const antes = Number(safe(() => sessionStorage.getItem("kb_before"), "0")) || 0;
        for (let i = 0; i < 6 && activeSlugs().size <= antes; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          await refreshEnts();
        }
        aviso = activeSlugs().size > antes
          ? { type: "ok", text: "¡Pago recibido! Tu plan ya está activo." }
          : { type: "warn", text: "Estamos confirmando tu pago. Tu acceso se activará en unos minutos; si no ocurre, recarga la página." };
      } else if (p === "pendiente") {
        aviso = { type: "warn", text: "Tu pago está pendiente. Cuando Mercado Pago lo confirme, tu plan se activará automáticamente." };
      } else {
        aviso = { type: "err", text: "El pago no se completó. No se hizo ningún cobro; puedes intentarlo de nuevo." };
      }
      if (mine !== loadSeq) return;
    }
    armTrialTimer();
    if (hasActive()) {
      const ok = await catalogo;
      if (mine !== loadSeq) return;
      go("inicio", ok ? aviso : { type: "err", text: "No se pudieron cargar los exámenes." });
    } else {
      go("planes", aviso || (trialVencida() ? { type: "warn", text: "Tu prueba gratis de 24 horas terminó. Elige un plan para seguir estudiando." } : null));
    }
  } catch {
    if (mine !== loadSeq) return;
    go("planes", { type: "err", text: "No se pudo cargar tu cuenta. Recarga la página." });
  }
}

/* ---------- vistas ---------- */

function loader() {
  return h("div", { class: "loader", role: "status", "aria-live": "polite" },
    h("p", { class: "muted" }, "Cargando…"),
    h("div", { class: "loadbar", "aria-hidden": "true" }, h("i", {})));
}

function render() {
  app.replaceChildren();
  if (state.view === "cargando") {
    app.append(loader());
    return;
  }
  if (state.session && state.view !== "visitante" && state.view !== "recuperar") app.append(topbar());
  if (state.notice) app.append(h("div", { class: "msg " + state.notice.type, role: "status" }, state.notice.text));
  const vistas = {
    visitante: viewVisitante, usuarios: viewUsuarios, planes: viewPlanes, cuenta: viewCuenta, inicio: viewInicio,
    recuperar: viewRecuperar, reportes: viewReportes, estcfg: viewEstCfg, estudio: viewEstudio, simcfg: viewSimCfg, sim: viewSim, resultado: viewResultado, cabina: viewCabina
  };
  app.append((vistas[state.view] || viewVisitante)());
}

const avatarUrl = () => (state.session && state.session.user && state.session.user.user_metadata && state.session.user.user_metadata.avatar_url) || null;
function avatarEl(extra) {
  const url = avatarUrl();
  const inicial = (state.name || "?").trim().charAt(0).toUpperCase();
  return url
    ? h("img", { class: "avatar img " + (extra || ""), src: url, alt: "", "aria-hidden": "true" })
    : h("span", { class: "avatar " + (extra || ""), "aria-hidden": "true" }, inicial);
}

function openCuenta(tab) {
  state.cuentaTab = tab || "perfil";
  if (state.cuentaTab === "stats") loadStats();
  go("cuenta");
}

document.addEventListener("click", (ev) => {
  if (state.menu && !ev.target.closest(".usermenu")) { state.menu = false; render(); }
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && state.menu) { state.menu = false; render(); } });

function topbar() {
  const item = (txt, fn, ic) => h("button", { class: "mitem", type: "button", role: "menuitem", onclick: fn }, h("span", { "aria-hidden": "true" }, ic), txt);
  return h("header", { class: "topbar" },
    h("button", { class: "brand", type: "button", "aria-label": "PilotPrep, ir al inicio", onclick: () => go(hasActive() ? "inicio" : "planes") },
      h("img", { src: "img/icon.png", alt: "", width: "36", height: "36" }), h("span", {}, "PilotPrep")),
    h("div", { class: "user usermenu" },
      puedeCabina() ? h("button", { class: "btn ghost small", type: "button", onclick: () => openCabina() }, "Cabina 3D") : null,
      state.isAdmin ? h("button", { class: "btn ghost small", type: "button", onclick: () => openUsuarios() }, "Panel") : null,
      h("button", { class: "userlink" + (state.view === "cuenta" || state.menu ? " on" : ""), type: "button", "aria-haspopup": "menu", "aria-expanded": String(!!state.menu), "aria-label": "Menú de usuario",
        onclick: (ev) => { ev.stopPropagation(); state.menu = !state.menu; render(); } },
        avatarEl(), h("span", { class: "uname" }, state.name), h("span", { class: "caret", "aria-hidden": "true" }, "▾")),
      state.menu ? h("div", { class: "menu", role: "menu" },
        h("div", { class: "mhead" }, avatarEl("big"), h("div", {}, h("b", {}, state.name), h("span", {}, state.session && state.session.user ? state.session.user.email : ""))),
        item("Mi perfil", () => openCuenta("perfil"), "👤"),
        item("Mis estadísticas", () => openCuenta("stats"), "📊"),
        item("Mi plan", () => openCuenta("plan"), "🎟️"),
        item("Cambiar contraseña", () => openCuenta("seg"), "🔒"),
        h("div", { class: "msep" }),
        item("Cerrar sesión", () => sb.auth.signOut(), "↩")) : null
    )
  );
}

/* Visitante: presentación + ingresar / crear cuenta */
function viewVisitante() {
  let modo = "login";

  const nombre = h("input", { id: "nombre", type: "text", autocomplete: "name", maxlength: "60" });
  const correo = h("input", { id: "correo", type: "email", autocomplete: "email", required: true });
  const clave = h("input", { id: "clave", type: "password", autocomplete: "current-password", minlength: "8", required: true });
  const campoNombre = h("div", { class: "field", hidden: true }, h("label", { for: "nombre" }, "Nombre"), nombre);
  const hintClave = h("p", { class: "hint", hidden: true }, "Mínimo 8 caracteres.");
  const enviar = h("button", { class: "btn block", type: "submit" }, "Ingresar");
  const msg = h("div", { class: "msg inline", role: "status", hidden: true });
  const tabLogin = h("button", { type: "button", role: "tab", "aria-selected": "true" }, "Ingresar");
  const tabSignup = h("button", { type: "button", role: "tab", "aria-selected": "false" }, "Crear cuenta");
  const recordar = h("input", { id: "recordar", type: "checkbox", class: "chk" });
  recordar.checked = remember();
  const filaRecordar = h("div", { class: "field row-between" },
    h("label", { for: "recordar", class: "chk-label" }, recordar, "Mantener sesión iniciada"),
    h("button", { type: "button", class: "link", onclick: () => setModo("reset") }, "Olvidé mi contraseña")
  );
  const campoClave = h("div", { class: "field" }, h("label", { for: "clave" }, "Contraseña"), clave, hintClave);
  const volver = h("button", { type: "button", class: "link", hidden: true, onclick: () => setModo("login") }, "← Volver a ingresar");

  const mostrar = (tipo, texto) => { msg.className = "msg inline " + tipo; msg.textContent = texto; msg.hidden = false; };

  function setModo(nuevo) {
    modo = nuevo;
    const alta = modo === "signup";
    const reset = modo === "reset";
    tabLogin.setAttribute("aria-selected", String(modo === "login"));
    tabSignup.setAttribute("aria-selected", String(alta));
    campoNombre.hidden = !alta;
    hintClave.hidden = !alta;
    campoClave.hidden = reset;
    filaRecordar.hidden = modo !== "login";
    volver.hidden = !reset;
    clave.required = !reset;
    clave.autocomplete = alta ? "new-password" : "current-password";
    enviar.textContent = alta ? "Crear cuenta" : reset ? "Enviar enlace" : "Ingresar";
    msg.hidden = true;
  }
  tabLogin.addEventListener("click", () => setModo("login"));
  tabSignup.addEventListener("click", () => setModo("signup"));

  const form = h("form", { novalidate: true },
    campoNombre,
    h("div", { class: "field" }, h("label", { for: "correo" }, "Correo"), correo),
    campoClave,
    filaRecordar,
    enviar, volver, msg
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.hidden = true;
    const email = correo.value.trim();
    const password = clave.value;
    if (modo === "reset") {
      if (!email) { mostrar("err", "Escribe tu correo."); return; }
      enviar.disabled = true;
      try {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        mostrar("ok", "Si el correo tiene una cuenta, te enviamos un enlace para crear una nueva contraseña. Revisa también el spam.");
      } catch (err) {
        mostrar("err", errorText(err));
      } finally {
        enviar.disabled = false;
      }
      return;
    }
    if (!email || !password) { mostrar("err", "Completa correo y contraseña."); return; }
    if (modo === "signup" && password.length < 8) { mostrar("err", "La contraseña debe tener al menos 8 caracteres."); return; }
    enviar.disabled = true;
    try {
      if (modo === "signup") {
        const { data, error } = await sb.auth.signUp({
          email, password, options: { data: { display_name: nombre.value.trim() } }
        });
        if (error) throw error;
        if (!data.session) mostrar("ok", "Cuenta creada. Revisa tu correo para confirmarla.");
      } else {
        setRemember(recordar.checked);
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      mostrar("err", errorText(err));
    } finally {
      enviar.disabled = false;
    }
  });

  return h("section", { class: "hero landing" },
    h("div", { class: "pitch" },
      h("img", { class: "logo", src: "img/logo.webp", alt: "PilotPrep · Aprender, practicar, aprobar", width: "760", height: "509" }),
      h("h1", {}, "Estudia hasta dominar cada pregunta"),
      h("p", {}, "Elige las asignaturas y la cantidad de preguntas. Las que falles vuelven a aparecer hasta que las resuelvas todas, y cada respuesta tiene su explicación."),
      h("ul", { class: "checks" },
        h("li", {}, "Modo estudio que repite lo fallado"),
        h("li", {}, "Examen simulado con corrección al terminar"),
        h("li", {}, "Explicación de cada respuesta correcta")
      )
    ),
    h("div", { class: "card authcard" },
      h("div", { class: "tabs", role: "tablist", "aria-label": "Acceso" }, tabLogin, tabSignup),
      form
    )
  );
}

/* Nueva contraseña (tras el enlace del correo) */
function viewRecuperar() {
  const nueva = h("input", { id: "nueva", type: "password", autocomplete: "new-password", minlength: "8", required: true });
  const repite = h("input", { id: "repite", type: "password", autocomplete: "new-password", minlength: "8", required: true });
  const msg = h("div", { class: "msg inline", role: "status", hidden: true });
  const enviar = h("button", { class: "btn block", type: "submit" }, "Guardar contraseña");
  const form = h("form", { novalidate: true },
    h("div", { class: "field" }, h("label", { for: "nueva" }, "Nueva contraseña"), nueva, h("p", { class: "hint" }, "Mínimo 8 caracteres.")),
    h("div", { class: "field" }, h("label", { for: "repite" }, "Repite la contraseña"), repite),
    enviar, msg);
  const mostrar = (t, x) => { msg.className = "msg inline " + t; msg.textContent = x; msg.hidden = false; };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (nueva.value.length < 8) { mostrar("err", "La contraseña debe tener al menos 8 caracteres."); return; }
    if (nueva.value !== repite.value) { mostrar("err", "Las contraseñas no coinciden."); return; }
    enviar.disabled = true;
    const { error } = await sb.auth.updateUser({ password: nueva.value });
    if (error) { enviar.disabled = false; mostrar("err", errorText(error)); return; }
    state.recovery = false;
    safe(() => history.replaceState(null, "", location.pathname));
    const { data: { session } } = await sb.auth.getSession();
    await loadAccount(session);
    if (session) setNotice("ok", "Contraseña actualizada."), render();
  });
  return h("section", { class: "card", style: "max-width:460px;margin:24px auto 0" },
    h("h2", { style: "margin-bottom:10px" }, "Crea una nueva contraseña"), form);
}

/* Mi cuenta */
function passwordCard() {
  const email = state.session && state.session.user ? state.session.user.email : "";
  const actual = h("input", { id: "pw0", type: "password", autocomplete: "current-password", required: true });
  const nueva = h("input", { id: "pw1", type: "password", autocomplete: "new-password", minlength: "8", required: true });
  const repite = h("input", { id: "pw2", type: "password", autocomplete: "new-password", minlength: "8", required: true });
  const msg = h("div", { class: "msg inline", role: "status", hidden: true });
  const enviar = h("button", { class: "btn", type: "submit" }, "Cambiar contraseña");
  const mostrar = (t, x) => { msg.className = "msg inline " + t; msg.textContent = x; msg.hidden = false; };
  const form = h("form", { novalidate: true },
    h("div", { class: "field" }, h("label", { for: "pw0" }, "Contraseña actual"), actual),
    h("div", { class: "field" }, h("label", { for: "pw1" }, "Nueva contraseña"), nueva, h("p", { class: "hint" }, "Mínimo 8 caracteres.")),
    h("div", { class: "field" }, h("label", { for: "pw2" }, "Repite la nueva contraseña"), repite),
    enviar, msg);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.hidden = true;
    if (!actual.value) { mostrar("err", "Escribe tu contraseña actual."); return; }
    if (nueva.value.length < 8) { mostrar("err", "La nueva contraseña debe tener al menos 8 caracteres."); return; }
    if (nueva.value !== repite.value) { mostrar("err", "Las contraseñas nuevas no coinciden."); return; }
    if (nueva.value === actual.value) { mostrar("err", "La nueva contraseña debe ser distinta de la actual."); return; }
    enviar.disabled = true;
    try {
      const { data: lg, error: e1 } = await sb.auth.signInWithPassword({ email, password: actual.value });
      if (e1) { mostrar("err", "La contraseña actual no es correcta."); return; }
      await reclamarSesion(lg && lg.session);
      const { error: e2 } = await sb.auth.updateUser({ password: nueva.value });
      if (e2) throw e2;
      form.reset();
      mostrar("ok", "Contraseña actualizada.");
    } catch (err) {
      mostrar("err", errorText(err));
    } finally {
      enviar.disabled = false;
    }
  });
  return h("div", { class: "card stack", style: "max-width:520px" }, h("h2", {}, "Cambiar contraseña"), form);
}

/* ---------- Mi cuenta ---------- */

async function reclamarSesion(session) {
  // Tras un inicio de sesión nuevo en este mismo dispositivo, la sesión vigente pasa a ser esta.
  const sid = session ? sessionIdOf(session) : null;
  if (!sid) return;
  await syncSession(true);
  safe(() => authStorage.setItem("pp_sid", sid));
}

async function resizeAvatar(file) {
  const bmp = await createImageBitmap(file);
  const S = 256, c = document.createElement("canvas");
  c.width = c.height = S;
  const m = Math.min(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, (bmp.width - m) / 2, (bmp.height - m) / 2, m, m, 0, 0, S, S);
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
}

function profileCard() {
  const u = state.session.user;
  const msg = h("div", { class: "msg inline", role: "status", hidden: true });
  const mostrar = (t, x) => { msg.className = "msg inline " + t; msg.textContent = x; msg.hidden = false; };
  const pick = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: true });
  const foto = h("div", { class: "avwrap" }, avatarEl("xl"));

  pick.addEventListener("change", async () => {
    const f = pick.files && pick.files[0]; pick.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type)) { mostrar("err", "Elige una imagen (JPG, PNG o WebP)."); return; }
    mostrar("warn", "Subiendo foto…");
    try {
      const blob = await resizeAvatar(f);
      const path = u.id + "/avatar.jpg";
      const up = await sb.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
      if (up.error) throw up.error;
      const url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl + "?v=" + Date.now();
      const { data, error } = await sb.auth.updateUser({ data: { avatar_url: url } });
      if (error) throw error;
      if (data && data.user) state.session = { ...state.session, user: data.user };
      setNotice("ok", "Foto de perfil actualizada."); render();
    } catch (e) { mostrar("err", "No se pudo subir la foto" + (e && e.message ? " (" + e.message + ")" : "") + ". Prueba con otra imagen."); }
  });
  const quitar = async () => {
    mostrar("warn", "Quitando foto…");
    try {
      await sb.storage.from("avatars").remove([u.id + "/avatar.jpg"]);
      const { data, error } = await sb.auth.updateUser({ data: { avatar_url: null } });
      if (error) throw error;
      if (data && data.user) state.session = { ...state.session, user: data.user };
      setNotice("ok", "Foto eliminada."); render();
    } catch (e) { mostrar("err", errorText(e)); }
  };

  const nombre = h("input", { id: "pname", type: "text", maxlength: "60", value: state.name, autocomplete: "name" });
  const guardar = h("button", { class: "btn", type: "submit" }, "Guardar nombre");
  const form = h("form", { novalidate: true, class: "stack" },
    h("div", { class: "field" }, h("label", { for: "pname" }, "Nombre"), nombre), guardar);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = nombre.value.trim();
    if (v.length < 2) { mostrar("err", "Escribe tu nombre (mínimo 2 caracteres)."); return; }
    guardar.disabled = true;
    try {
      const { error } = await sb.from("profiles").update({ display_name: v }).eq("id", u.id);
      if (error) throw error;
      await sb.auth.updateUser({ data: { display_name: v } });
      state.name = v; setNotice("ok", "Nombre actualizado."); render();
    } catch (err) { mostrar("err", errorText(err)); guardar.disabled = false; }
  });

  const fecha = (x) => x ? new Date(x).toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" }) : "—";
  const planes = state.ents.filter(vigente).map((e) => e.plans.name + (e.expires_at ? " (hasta " + new Date(e.expires_at).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }) + ")" : ""));
  const dato = (k, v) => h("div", { class: "kv" }, h("span", {}, k), h("b", {}, v));

  return h("div", { class: "stack" },
    h("div", { class: "card stack" },
      h("h2", {}, "Foto de perfil"),
      h("div", { class: "row", style: "gap:18px" }, foto,
        h("div", { class: "stack", style: "margin:0" },
          h("div", { class: "row" },
            h("button", { class: "btn", type: "button", onclick: () => pick.click() }, avatarUrl() ? "Cambiar foto" : "Subir foto"),
            avatarUrl() ? h("button", { class: "btn ghost", type: "button", onclick: quitar }, "Quitar") : null),
          h("p", { class: "hint" }, "JPG, PNG o WebP. Se recorta en cuadrado automáticamente.")),
        pick), msg),
    h("div", { class: "card stack", style: "max-width:520px" }, h("h2", {}, "Datos de la cuenta"), form),
    h("div", { class: "card" }, h("h2", { style: "margin-bottom:6px" }, "Resumen"),
      dato("Correo", u.email || "—"),
      dato("Miembro desde", fecha(u.created_at)),
      dato("Último acceso", fecha(u.last_sign_in_at)),
      dato("Plan activo", planes.length ? planes.join(" · ") : "Sin plan activo"))
  );
}

/* Estadísticas */
async function loadStats() {
  const st = { loading: true, data: null, error: null };
  state.stats = st;
  const { data, error } = await sb.rpc("my_stats");
  if (state.stats !== st) return;
  st.loading = false;
  if (error) st.error = errorText(error); else st.data = data;
  if (state.view === "cuenta" && state.cuentaTab === "stats") render();
}

function studyTopic(examId, topic) {
  const ex = state.exams.find((e) => e.id === examId);
  if (!ex || ex.locked || !ex.total) { go("planes"); return; }
  startStudy(ex);
  const t = (ex.topics || []).find((x) => x.name === topic);
  if (t) { state.studyCfg.sel = new Set([topic]); state.studyCfg.count = Math.min(20, t.count); }
  render();
}

const nivelDe = (t) => {
  if (t.answered < 5) return { k: "low", txt: "Pocos datos" };
  const p = t.correct / t.answered;
  if (p >= 0.8) return { k: "ok", txt: "Fuerte" };
  if (p >= 0.6) return { k: "mid", txt: "En desarrollo" };
  return { k: "bad", txt: "Reforzar" };
};

function racha(days) {
  const set = new Set(days || []);
  const dia = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
  let d = new Date(), n = 0;
  if (!set.has(dia(d))) d = new Date(Date.now() - 86400000);
  while (set.has(dia(d))) { n++; d = new Date(d.getTime() - 86400000); }
  return n;
}

function statsView() {
  const st = state.stats;
  if (!st || st.loading) return loader();
  if (st.error) return h("div", { class: "msg err" }, st.error);
  const d = st.data;
  if (!d || !Number(d.answered)) {
    return h("div", { class: "card empty stack" },
      h("h2", {}, "Aún no hay estadísticas"),
      h("p", { class: "muted" }, "Responde preguntas en modo estudio o rinde un examen simulado y aquí verás tu avance, tus puntos fuertes y lo que te falta reforzar."),
      h("div", { class: "row", style: "justify-content:center" }, h("button", { class: "btn", type: "button", onclick: () => go("inicio") }, "Empezar a practicar")));
  }
  const ans = Number(d.answered), ok = Number(d.correct), mal = Number(d.incorrect);
  const pct = Math.round(ok / ans * 100);
  const tile = (v, l, tono) => statTile(v, l, tono);
  const topics = (d.topics || []).map((t) => ({ ...t, answered: Number(t.answered), correct: Number(t.correct), seen: Number(t.seen), total: Number(t.total), ra: Number(t.recent_answered), rc: Number(t.recent_correct) }));
  topics.forEach((t) => { t.pct = Math.round(t.correct / t.answered * 100); t.nivel = nivelDe(t); t.cov = t.total ? Math.min(100, Math.round(t.seen / t.total * 100)) : 0; });
  const conDatos = topics.filter((t) => t.answered >= 5);
  const base = conDatos.length ? conDatos : topics;
  const peor = base.slice().sort((a, b) => a.pct - b.pct)[0];
  const mejor = conDatos.length > 1 ? conDatos.slice().sort((a, b) => b.pct - a.pct)[0] : null;
  const pocoVista = topics.filter((t) => t.cov < 30 && t.total >= 10).sort((a, b) => a.cov - b.cov)[0];

  const diag = [];
  if (mejor && peor && mejor !== peor) diag.push(h("p", {}, "💪 Tu asignatura más fuerte es ", h("b", {}, mejor.topic), " (" + mejor.pct + "% de aciertos)."));
  if (peor && peor.pct < 80) diag.push(h("p", {}, "🎯 Prioridad de estudio: ", h("b", {}, peor.topic), " (" + peor.pct + "% de aciertos en " + plural(peor.answered, "respuesta", "respuestas") + ")."));
  else if (peor) diag.push(h("p", {}, "✅ Vas muy bien en todas las asignaturas con datos. Sigue practicando para mantener el nivel."));
  if (pocoVista && (!peor || pocoVista.topic !== peor.topic)) diag.push(h("p", {}, "👀 En ", h("b", {}, pocoVista.topic), " solo has visto el " + pocoVista.cov + "% de las preguntas."));
  if (conDatos.length === 0) diag.push(h("p", { class: "muted" }, "Responde al menos 5 preguntas por asignatura para afinar el diagnóstico."));

  const filas = topics.slice().sort((a, b) => a.pct - b.pct).map((t) => {
    const tend = t.ra >= 5 ? Math.round(t.rc / t.ra * 100) - t.pct : null;
    return h("div", { class: "trow" },
      h("div", { class: "thead" },
        h("div", { class: "tname" }, h("b", {}, t.topic), h("span", {}, t.exam_title)),
        h("span", { class: "lvl " + t.nivel.k }, t.nivel.txt)),
      h("div", { class: "bar big " + t.nivel.k }, h("i", { style: "width:" + t.pct + "%" })),
      h("div", { class: "tmeta" },
        h("b", {}, t.pct + "%"),
        h("span", {}, t.correct + " de " + t.answered + " acertadas"),
        h("span", {}, "Visto " + Math.min(t.seen, t.total) + "/" + t.total + " (" + t.cov + "%)"),
        tend != null && Math.abs(tend) >= 8 ? h("span", { class: tend > 0 ? "up" : "down" }, (tend > 0 ? "↑ Mejorando" : "↓ Bajando") + " (14 días)") : null,
        t.nivel.k === "bad" || t.nivel.k === "mid" ? h("button", { class: "link", type: "button", onclick: () => studyTopic(t.exam_id, t.topic) }, "Estudiar esto →") : null));
  });

  const weak = (d.weak || []).map((w) => h("div", { class: "weak" },
    h("p", {}, w.statement.length > 170 ? w.statement.slice(0, 167) + "…" : w.statement),
    h("div", { class: "row", style: "gap:8px" },
      h("span", { class: "pill" }, w.topic),
      h("span", { class: "pill bad" }, "Fallada " + plural(Number(w.wrong), "vez", "veces")))));

  const att = (d.attempts || []).slice().reverse();
  const chart = att.length ? h("div", { class: "abars", role: "img", "aria-label": "Notas de tus últimos simulados" },
    ...att.map((a) => { const p = Math.round(Number(a.score) / Number(a.total_questions) * 100);
      return h("div", { class: "abar" }, h("span", { class: "av" }, p + "%"), h("i", { style: "height:" + Math.max(6, p) + "%" , class: p >= 60 ? "" : "low" }),
        h("span", { class: "ad" }, new Date(a.finished_at).toLocaleDateString("es-CL", { day: "numeric", month: "short" }))); })) : null;

  return h("div", { class: "stack" },
    h("div", { class: "stiles four" },
      tile(ans, "Respondidas"), tile(ok, "Acertadas", "ok"), tile(mal, "Erradas", mal ? "bad" : ""), tile(pct + "%", "Precisión")),
    h("div", { class: "stiles four" },
      tile(Number(d.attempts_done), "Simulados rendidos"),
      tile(d.attempts_best != null ? d.attempts_best + "%" : "—", "Mejor simulado"),
      tile(d.attempts_avg != null ? d.attempts_avg + "%" : "—", "Promedio simulados"),
      tile((racha(d.days) > 1 ? "🔥 " : "") + racha(d.days) + (racha(d.days) === 1 ? " día" : " días"), "Racha de estudio")),
    h("div", { class: "card stack diag" }, h("h2", {}, "Tu diagnóstico"), ...diag,
      peor && peor.pct < 80 ? h("div", {}, h("button", { class: "btn", type: "button", onclick: () => studyTopic(peor.exam_id, peor.topic) }, "Estudiar " + peor.topic)) : null),
    h("div", { class: "card stack" }, h("h2", {}, "Rendimiento por asignatura"), ...filas),
    weak.length ? h("div", { class: "card stack" }, h("h2", {}, "Conceptos a reforzar"),
      h("p", { class: "hint" }, "Las preguntas que más has fallado. Revisa estos temas con calma."), ...weak) : null,
    att.length ? h("div", { class: "card stack" }, h("h2", {}, "Tus últimos simulados"), chart) : null
  );
}

function viewCuenta() {
  const tab = state.cuentaTab || "perfil";
  const tabs = [["perfil", "Perfil"], ["stats", "Estadísticas"], ["plan", "Mi plan"], ["seg", "Seguridad"]];
  const nav = h("div", { class: "seg ctabs", role: "tablist", "aria-label": "Mi cuenta" },
    ...tabs.map(([k, l]) => h("button", { type: "button", role: "tab", "aria-pressed": String(tab === k), onclick: () => openCuenta(k) }, l)));
  const cuerpo = tab === "stats" ? statsView() : tab === "plan" ? plansSection(true) : tab === "seg" ? passwordCard() : profileCard();
  return h("section", { class: "stack" },
    h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => go(hasActive() ? "inicio" : "planes") }, "← Volver")),
    h("div", { class: "row", style: "gap:14px" }, avatarEl("lg"), h("div", {}, h("h1", {}, state.name), h("p", { class: "muted" }, state.session.user.email))),
    nav,
    cuerpo);
}

/* Planes */
function viewPlanes() { return plansSection(false); }

function plansSection(enCuenta) {
  const activos = activeSlugs();
  const tieneBase = activos.has("piloto-privado");
  const amplia = activos.size > 0;
  const sec = h("section", { class: "stack" });

  sec.append(
    h("div", {},
      enCuenta ? h("h2", {}, amplia ? "Mis planes y ampliación" : "Planes") : h("h1", {}, "Elige tu plan"),
      h("p", { class: "muted", style: "margin-top:6px" },
        amplia ? "Suma más exámenes a tu cuenta." : "Para empezar, elige el plan que quieres comprar.")
    )
  );

  sec.append(couponBox());

  const cup = state.coupon;
  const conDesc = (n) => Math.round(Number(n) * (100 - cup.percent) / 100);
  const grid = h("div", { class: "plans" });
  for (const plan of state.plans) {
    const activo = activos.has(plan.slug);
    const esAmpliacion = !activo && tieneBase && !!plan.upgrade_from_plan_id;
    const monto = esAmpliacion ? plan.upgrade_price_amount : plan.price_amount;
    const precioLista = fmtPrice(monto, plan.currency);
    const precio = cup && monto != null ? fmtPrice(conDesc(monto), plan.currency) : precioLista;

    let ahorro = null;
    const base = state.plans.find((x) => x.id === plan.upgrade_from_plan_id) || state.plans.find((x) => x.slug === "piloto-privado");
    if (!activo && !tieneBase && plan.upgrade_from_plan_id && base && base.price_amount != null && plan.upgrade_price_amount != null && plan.price_amount != null) {
      const separado = Number(base.price_amount) + Number(plan.upgrade_price_amount);
      const dif = separado - Number(plan.price_amount);
      if (dif > 0) ahorro = h("p", { class: "saving" },
        "Mejor opción: comprar " + base.name + " y ampliar después costaría " + fmtPrice(separado, plan.currency) + ". Con este paquete ahorras " + fmtPrice(dif, plan.currency) + ".");
    }

    let boton;
    if (activo) boton = h("button", { class: "btn block", type: "button", disabled: true }, "Plan activo");
    else boton = h("button", { class: "btn block", type: "button", disabled: plan.price_amount == null, onclick: (ev) => choosePlan(plan.slug, ev.currentTarget) },
      "Pagar " + precio);

    grid.append(h("article", { class: "card item" },
      activo ? h("span", { class: "tag ok" }, "Activo") : null,
      esAmpliacion ? h("span", { class: "tag" }, "Ampliación desde Piloto Privado") : null,
      h("h3", {}, plan.name),
      h("p", { class: "muted grow" }, plan.description || ""),
      h("div", { class: "price" }, cup && monto != null ? h("s", { class: "muted", style: "font-size:.6em;margin-right:8px" }, precioLista) : null, precio),
      cup && monto != null ? h("span", { class: "tag ok" }, "Cupón " + cup.code + " · " + cup.percent + "% de descuento") : null,
      ahorro,
      boton
    ));
  }
  sec.append(grid);
  return sec;
}

function couponBox() {
  const cup = state.coupon;
  const msg = h("p", { class: "hint", role: "status", hidden: true });
  const input = h("input", { id: "cupon", type: "text", placeholder: "Código de cupón", autocomplete: "off", maxlength: "30", style: "text-transform:uppercase" });
  const btn = h("button", { class: "btn ghost small", type: "button" }, "Aplicar");
  const aplicar = async () => {
    const code = input.value.trim().toUpperCase();
    if (!code) return;
    btn.disabled = true; msg.hidden = true;
    const { data, error } = await sb.rpc("validate_coupon_n", { p_code: code });
    btn.disabled = false;
    if (error) { msg.textContent = errorText(error); msg.hidden = false; return; }
    state.coupon = { code, percent: Number(data) };
    render();
  };
  btn.addEventListener("click", aplicar);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); aplicar(); } });
  if (cup) {
    return h("div", { class: "card row", style: "justify-content:space-between" },
      h("span", {}, "Cupón ", h("b", {}, cup.code), " aplicado: " + cup.percent + "% de descuento."),
      h("button", { class: "link", type: "button", onclick: () => { state.coupon = null; render(); } }, "Quitar"));
  }
  return h("div", { class: "card stack", style: "max-width:460px" },
    h("label", { for: "cupon" }, "¿Tienes un cupón de descuento?"),
    h("div", { class: "row" }, input, btn), msg);
}

async function choosePlan(slug, btn) {
  btn.disabled = true;
  safe(() => sessionStorage.setItem("kb_before", String(activeSlugs().size)));
  const txt = btn.textContent;
  btn.textContent = "Redirigiendo a Mercado Pago…";
  setNotice(null);
  try {
    const { data, error } = await sb.functions.invoke("create-payment", { body: { plan_slug: slug, coupon_code: state.coupon ? state.coupon.code : null } });
    if (error || !data || !data.init_point) {
      let msg = "No se pudo iniciar el pago. Inténtalo de nuevo.";
      try { const j = error && error.context && (await error.context.json()); if (j && j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    location.href = data.init_point;
  } catch (e) {
    btn.disabled = false; btn.textContent = txt;
    setNotice("err", e.message || "No se pudo iniciar el pago.");
    render();
  }
}

/* Inicio: exámenes disponibles */
function viewInicio() {
  const activos = activeSlugs();
  const primer = (state.name || "").split(" ")[0];
  const sec = h("section", { class: "stack" });
  sec.append(h("div", {},
    h("h1", {}, primer ? "Hola, " + primer : "Hola"),
    h("p", { class: "muted", style: "margin-top:6px" }, "Elige un examen para estudiar o rendir un simulado.")
  ));

  const prueba = trialEnt();
  if (prueba) {
    sec.append(h("div", { class: "msg warn", role: "status" },
      "Estás en tu prueba gratis: tienes acceso a Piloto Privado por " + tiempoRestante(prueba.expires_at) + ". ",
      h("button", { class: "link", type: "button", onclick: () => go("planes") }, "Ver planes")));
  }

  if (!state.exams.length) {
    sec.append(h("div", { class: "card empty" }, h("p", { class: "muted" }, "Todavía no hay exámenes disponibles en tu cuenta.")));
  } else {
    const grid = h("div", { class: "exams" });
    for (const ex of state.exams) {
      const vacio = ex.total === 0;
      if (ex.locked) {
        grid.append(h("article", { class: "card item locked" },
          h("span", { class: "tag" }, "🔒 " + plural(ex.total, "pregunta", "preguntas")),
          h("h3", {}, ex.title),
          h("p", { class: "muted grow" }, ex.description || ""),
          h("p", { class: "hint" }, "Sin acceso con tu plan actual."),
          h("div", { class: "row" },
            h("button", { class: "btn", type: "button", onclick: () => go("planes") }, "Ver planes"))
        ));
        continue;
      }
      grid.append(h("article", { class: "card item" },
        h("span", { class: "tag" }, plural(ex.total, "pregunta", "preguntas")),
        h("h3", {}, ex.title),
        h("p", { class: "muted grow" }, ex.description || ""),
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", disabled: vacio, onclick: () => startStudy(ex) }, "Modo estudio"),
          h("button", { class: "btn ghost", type: "button", disabled: vacio, onclick: () => openSimCfg(ex) }, "Examen simulado")
        )
      ));
    }
    sec.append(grid);
  }

  return sec;
}

/* Figuras de apoyo (imágenes del material de la DGAC) */
function figuresBlock(q) {
  const lista = Array.isArray(q.figures) ? q.figures : [];
  if (!lista.length) return null;
  return h("div", { class: "figs" }, ...lista.map((src, i) =>
    h("a", { href: src, target: "_blank", rel: "noopener", class: "fig", title: "Abrir figura en grande" },
      h("img", { src, alt: "Figura de apoyo " + (i + 1) + " de " + lista.length, loading: "lazy" }))));
}

/* Bloque de pregunta compartido */
function questionBlock(q, i, total, opts) {
  const rev = opts.revealed;
  const lista = h("div", { class: "opts", role: "group", "aria-label": "Opciones de respuesta" });
  for (const o of q.options) {
    let cls = "opt";
    if (rev) {
      if (o.id === rev.correct) cls += " correct";
      else if (o.id === opts.picked) cls += " wrong";
    } else if (opts.verdict && o.id === opts.picked) {
      cls += opts.verdict === "ok" ? " correct" : " wrong";
    }
    lista.append(h("button", {
      type: "button", class: cls, "aria-pressed": String(o.id === opts.picked),
      disabled: !!rev || !!opts.verdict, onclick: () => opts.onPick(o.id)
    }, h("span", { class: "lt" }, o.label), h("span", {}, o.text)));
  }
  return h("div", { class: "card" },
    h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(opts.pct != null ? opts.pct : i + 1) },
      h("i", { style: "width:" + (opts.pct != null ? opts.pct : Math.round(((i + 1) / total) * 100)) + "%" })),
    h("div", { class: "qhead" },
      h("span", { class: "pill strong" }, opts.meta || "Pregunta " + (i + 1) + " de " + total),
      q.topic ? h("span", { class: "pill" }, q.topic) : null),
    h("h2", { class: "qtext" }, q.statement),
    figuresBlock(q),
    lista,
    opts.extra || null
  );
}

/* ---------- panel lateral (estudio y simulado) ---------- */

const fmtTime = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return (hh ? hh + ":" + p2(mm) : mm) + ":" + p2(ss);
};
setInterval(() => {
  for (const e of document.querySelectorAll(".clk")) e.textContent = fmtTime(Date.now() - Number(e.dataset.t0));
}, 1000);

function ring(pct, big, small) {
  return h("div", { class: "ring", style: "--p:" + Math.max(0, Math.min(100, pct)), role: "img", "aria-label": big + " " + (small || "") },
    h("div", {}, h("b", {}, big), small ? h("span", {}, small) : null));
}
function statTile(valor, etiqueta, tono) {
  return h("div", { class: "stile" + (tono ? " " + tono : "") }, h("b", {}, valor), h("span", {}, etiqueta));
}
function topicBars(items) {
  if (items.length < 2) return null;
  return h("div", { class: "tbars" },
    h("h3", { class: "ptitle" }, "Por asignatura"),
    ...items.map((t) => h("div", { class: "tbar" },
      h("div", { class: "tbl" }, h("span", {}, t.name), h("b", {}, t.done + "/" + t.n)),
      h("div", { class: "bar" }, h("i", { style: "width:" + (t.n ? Math.round(t.done / t.n * 100) : 0) + "%" })))));
}
const byTopic = (qs, isDone) => {
  const m = new Map();
  for (const q of qs) { const k = q.topic || "General"; const r = m.get(k) || { name: k, n: 0, done: 0 }; r.n++; if (isDone(q)) r.done++; m.set(k, r); }
  return [...m.values()];
};

function mbar(pct, titulo, sub, t0, extra) {
  return h("div", { class: "mbar" },
    h("div", { class: "ring mini", style: "--p:" + Math.max(0, Math.min(100, pct)), "aria-hidden": "true" }, h("div", {})),
    h("div", { class: "mtxt" }, h("b", {}, titulo), h("span", {}, sub)),
    h("span", { class: "mclk" }, "⏱ ", h("b", { class: "clk", "data-t0": String(t0) }, fmtTime(Date.now() - t0))),
    extra || null);
}
const vibra = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch {} };

function studyPanel(s, faltan) {
  const resueltas = s.total - faltan;
  const pct = Math.round(resueltas / s.total * 100);
  const aRepetir = s.pending.filter((x) => s.failed.has(x.id)).length;
  const precision = s.attempts ? Math.round(resueltas / s.attempts * 100) : null;
  const pendIds = new Set(s.pending.map((x) => x.id));
  const mapa = h("div", { class: "qmap", "aria-label": "Mapa de preguntas" });
  for (const q of s.qs) {
    const hecha = !pendIds.has(q.id);
    const cls = hecha ? (s.firstTry.has(q.id) ? "ok" : "mid") : (s.failed.has(q.id) ? "bad" : "");
    mapa.append(h("i", { class: cls + (q.id === s.pending[0].id ? " cur" : "") }));
  }
  return h("aside", { class: "card sidepanel", "aria-label": "Tu avance" },
    h("div", { class: "ringrow" }, ring(pct, pct + "%", "resuelto"),
      h("div", { class: "ringtxt" }, h("b", {}, resueltas + " de " + s.total), h("span", {}, "preguntas resueltas"),
        h("span", { class: "clkrow" }, "⏱ ", h("b", { class: "clk", "data-t0": String(s.t0) }, fmtTime(Date.now() - s.t0))))),
    h("div", { class: "stiles" },
      statTile(s.firstTry.size, "A la primera", "ok"),
      statTile(aRepetir, "Por repetir", aRepetir ? "bad" : ""),
      statTile(precision == null ? "—" : precision + "%", "Precisión"),
      statTile(s.streak > 1 ? "🔥 " + s.streak : s.streak, "Racha actual")),
    h("div", {}, h("h3", { class: "ptitle" }, "Tu sesión"), mapa,
      h("div", { class: "legend" }, h("span", {}, h("i", { class: "ok" }), "A la primera"), h("span", {}, h("i", { class: "mid" }), "Tras repetir"),
        h("span", {}, h("i", { class: "bad" }), "Por repetir"), h("span", {}, h("i", {}), "Nueva"))),
    topicBars(byTopic(s.qs, (q) => !pendIds.has(q.id)))
  );
}

function simSheet(s, sinResponder) {
  const nav = h("div", { class: "qnav", role: "group", "aria-label": "Ir a la pregunta" });
  s.qs.forEach((q, idx) => nav.append(h("button", {
    type: "button", class: (s.answers[q.id] ? "done " : "") + (idx === s.i ? "cur" : ""),
    "aria-label": "Pregunta " + (idx + 1) + (s.answers[q.id] ? " respondida" : " sin responder"),
    onclick: (ev) => simGoto(idx, ev.currentTarget)
  }, String(idx + 1))));
  const cerrar = () => { s.sheet = false; render(); };
  return h("div", { class: "sheetwrap" },
    h("div", { class: "sheetbg", onclick: cerrar }),
    h("div", { class: "sheet", role: "dialog", "aria-label": "Preguntas del examen" },
      h("div", { class: "grab" }),
      h("div", { class: "row", style: "justify-content:space-between" },
        h("h3", { class: "ptitle", style: "margin:0" }, "Preguntas · " + (s.qs.length - sinResponder) + "/" + s.qs.length + " respondidas"),
        h("button", { class: "btn ghost small", type: "button", onclick: cerrar }, "Cerrar")),
      nav,
      h("div", { class: "legend" }, h("span", {}, h("i", { class: "done" }), "Respondida"), h("span", {}, h("i", {}), "Sin responder"), h("span", {}, h("i", { class: "curfill" }), "Actual")),
      h("button", { class: "btn block", type: "button", onclick: (ev) => simFinish(ev.currentTarget) }, "Finalizar examen")));
}

function simPanel(s, sinResponder) {
  const resp = s.qs.length - sinResponder;
  const pct = Math.round(resp / s.qs.length * 100);
  const nav = h("div", { class: "qnav", role: "group", "aria-label": "Ir a la pregunta" });
  s.qs.forEach((q, idx) => {
    nav.append(h("button", {
      type: "button", class: (s.answers[q.id] ? "done " : "") + (idx === s.i ? "cur" : ""), "aria-label": "Pregunta " + (idx + 1) + (s.answers[q.id] ? " respondida" : " sin responder"),
      "aria-current": idx === s.i ? "true" : null, onclick: (ev) => simGoto(idx, ev.currentTarget)
    }, String(idx + 1)));
  });
  return h("aside", { class: "card sidepanel", "aria-label": "Tu avance" },
    h("div", { class: "ringrow" }, ring(pct, resp + "/" + s.qs.length, "respondidas"),
      h("div", { class: "ringtxt" }, h("b", {}, sinResponder ? plural(sinResponder, "pendiente", "pendientes") : "¡Todas listas!"), h("span", {}, "pregunta " + (s.i + 1) + " de " + s.qs.length),
        h("span", { class: "clkrow" }, "⏱ ", h("b", { class: "clk", "data-t0": String(s.t0) }, fmtTime(Date.now() - s.t0))))),
    h("div", {}, h("h3", { class: "ptitle" }, "Navegador de preguntas"), nav,
      h("div", { class: "legend" }, h("span", {}, h("i", { class: "done" }), "Respondida"), h("span", {}, h("i", {}), "Sin responder"), h("span", {}, h("i", { class: "curfill" }), "Actual"))),
    topicBars(byTopic(s.qs, (q) => !!s.answers[q.id])),
    h("button", { class: "btn block", type: "button", onclick: (ev) => simFinish(ev.currentTarget) }, "Finalizar examen")
  );
}

/* Selector de asignaturas (compartido por estudio y simulado) */
function subjectPicker(exam, sel, onChange) {
  const todas = sel.size === exam.topics.length;
  const caja = h("div", { class: "subjects", role: "group", "aria-label": "Asignaturas" });
  caja.append(h("button", {
    type: "button", class: "chip", "aria-pressed": String(todas),
    onclick: () => { exam.topics.forEach((t) => sel.add(t.name)); onChange(); }
  }, "Todas"));
  for (const t of exam.topics) {
    caja.append(h("button", {
      type: "button", class: "chip", "aria-pressed": String(sel.has(t.name) && !todas),
      onclick: () => {
        if (todas) sel.clear();
        if (sel.has(t.name)) sel.delete(t.name); else sel.add(t.name);
        if (!sel.size) exam.topics.forEach((x) => sel.add(x.name));
        onChange();
      }
    }, t.name + " · " + t.count));
  }
  return caja;
}

const countOf = (exam, sel) => exam.topics.filter((t) => sel.has(t.name)).reduce((a, t) => a + t.count, 0);

/* Modo estudio: se repite lo fallado hasta resolver todo */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* Reparte n entre asignaturas lo más parejo posible (con tope por asignatura) */
function pickBalanced(qs, n) {
  const grupos = new Map();
  for (const q of qs) { const k = q.topic || ""; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(q); }
  const gs = [...grupos.values()].map(shuffle);
  const cupo = gs.map(() => 0);
  let resto = Math.min(n, qs.length);
  while (resto > 0) {
    const libres = gs.map((g, i) => i).filter((i) => cupo[i] < gs[i].length);
    if (!libres.length) break;
    const orden = shuffle(libres.slice());
    for (const i of orden) { if (resto > 0 && cupo[i] < gs[i].length) { cupo[i]++; resto--; } }
  }
  return shuffle(gs.flatMap((g, i) => g.slice(0, cupo[i])));
}

function countControls(c, total) {
  if (c.count > total) c.count = total;
  if (c.count < 1) c.count = 1;
  const opciones = [10, 20, 50].filter((n) => n < total).map((n) => ({ n, label: String(n) }));
  opciones.push({ n: total, label: total === 1 ? "1 pregunta" : "Todas (" + total + ")" });
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Cantidad de preguntas" });
  for (const o of opciones) {
    seg.append(h("button", { type: "button", "aria-pressed": String(c.count === o.n), onclick: () => { c.count = o.n; render(); } }, o.label));
  }
  const entrada = h("input", {
    type: "number", min: "1", max: String(total), value: String(c.count), inputmode: "numeric", class: "num",
    "aria-label": "Cantidad de preguntas",
    onchange: (ev) => { const v = parseInt(ev.target.value, 10); c.count = Number.isFinite(v) ? Math.max(1, Math.min(total, v)) : c.count; render(); }
  });
  return h("div", { class: "row" }, seg, entrada);
}

function startStudy(exam) {
  const topics = exam.topics || [];
  state.studyCfg = { exam, sel: new Set(topics.map((t) => t.name)), count: Math.min(20, exam.total) };
  go("estcfg");
}

function viewEstCfg() {
  const c = state.studyCfg;
  const topics = c.exam.topics || [];
  const total = topics.length ? countOf(c.exam, c.sel) : c.exam.total;
  const k = c.sel.size;
  return h("section", { class: "stack" },
    h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "← Volver")),
    h("div", { class: "card stack", style: "max-width:640px" },
      h("h1", { style: "font-size:clamp(22px,4vw,28px)" }, "Modo estudio"),
      h("p", { class: "muted" }, c.exam.title),
      topics.length > 1 ? h("div", {}, h("label", {}, "Asignaturas (una o más)"), subjectPicker(c.exam, c.sel, render)) : null,
      h("div", {}, h("label", {}, "¿Cuántas preguntas quieres estudiar? (máx. " + total + ")"), countControls(c, total)),
      h("p", { class: "hint" }, (topics.length > 1 && k > 1 ? "Se tomarán preguntas al azar de " + k + " asignaturas, en cantidades similares. " : "Las preguntas se eligen al azar. ") +
        "Si respondes mal, la pregunta vuelve a aparecer más adelante hasta que la aciertes. La respuesta correcta solo se muestra si la pides."),
      h("button", { class: "btn", type: "button", onclick: (ev) => beginStudy(ev.currentTarget) }, "Comenzar a estudiar")
    )
  );
}

async function beginStudy(btn) {
  const { exam, sel, count } = state.studyCfg;
  const todas = !exam.topics || !exam.topics.length || sel.size === exam.topics.length;
  btn.disabled = true;
  setNotice(null);
  try {
    const todo = await loadQuestions(exam.id, null, todas ? null : [...sel]);
    if (!todo.length) { btn.disabled = false; setNotice("warn", "Este banco aún no tiene preguntas."); render(); return; }
    const qs = pickBalanced(todo, count);
    state.study = { exam, pending: qs, total: qs.length, firstTry: new Set(), failed: new Set(), truth: {}, picked: null, result: null, rev: false, busy: false, attempts: 0, repeat: false, qs: qs.slice(), streak: 0, t0: Date.now() };
    go("estudio");
  } catch (e) {
    btn.disabled = false;
    setNotice("err", "No se pudieron cargar las preguntas."); render();
  }
}

async function studyTruth(q) {
  const s = state.study;
  if (s.truth[q.id]) return s.truth[q.id];
  const { data, error } = await sb.rpc("reveal_answer", { p_question_id: q.id });
  if (error || !data || !data.length) throw error || new Error("sin datos");
  s.truth[q.id] = { correct: data[0].correct_option_id, explanation: data[0].explanation };
  return s.truth[q.id];
}

async function studyAnswer(btn) {
  const s = state.study; const q = s.pending[0];
  if (!s.picked || s.busy) return;
  s.busy = true; btn.disabled = true; setNotice(null);
  try {
    const { data: acierto, error } = await sb.rpc("study_answer", { p_question_id: q.id, p_option_id: s.picked });
    if (error || typeof acierto !== "boolean") throw error || new Error("sin datos");
    s.attempts++;
    s.result = acierto ? "ok" : "bad";
    vibra(acierto ? 18 : [45, 60, 45]);
    if (s.result === "ok") { s.streak++; if (!s.failed.has(q.id)) s.firstTry.add(q.id); } else { s.streak = 0; s.failed.add(q.id); }
  } catch (e) { setNotice("err", errorText(e)); }
  s.busy = false; render();
}

async function studyReveal(btn) {
  const s = state.study; const q = s.pending[0];
  btn.disabled = true; setNotice(null);
  try {
    await studyTruth(q);
    s.rev = true;
    if (!s.result) { s.result = "bad"; s.failed.add(q.id); s.streak = 0; }
  } catch (e) { setNotice("err", errorText(e)); }
  render();
}

function studyNext() {
  const s = state.study; const q = s.pending.shift();
  if (s.result !== "ok") s.pending.push(q);
  s.picked = null; s.result = null; s.rev = false;
  s.repeat = s.pending.length ? s.failed.has(s.pending[0].id) : false;
  setNotice(null); render(); window.scrollTo(0, 0);
}

function viewEstudio() {
  const s = state.study;
  if (!s.pending.length) {
    const ok = s.firstTry.size;
    return h("section", { class: "stack" },
      h("div", { class: "score" },
        h("div", { class: "big" }, "100%"),
        h("div", {}, h("h2", { style: "color:#fff" }, "¡Resolviste todas las preguntas!"),
          h("p", {}, plural(s.total, "pregunta", "preguntas") + " · " + ok + " a la primera · " + plural(s.attempts, "intento", "intentos") + " en total"))),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => go("estcfg") }, "Estudiar otra vez"),
        h("button", { class: "btn ghost", type: "button", onclick: () => go("inicio") }, "Volver al inicio"))
    );
  }
  const q = s.pending[0];
  const faltan = s.pending.length;
  const t = s.rev ? s.truth[q.id] : null;
  const correcta = t ? q.options.find((o) => o.id === t.correct) : null;

  let extra = null;
  if (s.result) {
    const bloques = [h("b", {}, s.result === "ok" ? "¡Correcto!" : (s.picked ? "Incorrecta. Volverá a aparecer." : "Volverá a aparecer."))];
    if (t) {
      bloques.push(h("p", {}, "Respuesta correcta: " + (correcta ? correcta.label + ". " + correcta.text : "—")));
      bloques.push(h("p", {}, t.explanation || "Esta pregunta no tiene explicación todavía."));
      bloques.push(reportBox(q.id));
    }
    extra = h("div", { class: "explain" + (s.result === "bad" ? " bad" : "") }, ...bloques);
  }

  return h("section", { class: "stack" },
    h("div", { class: "row", style: "justify-content:space-between" },
      h("h1", { style: "font-size:clamp(20px,4vw,26px)" }, s.exam.title + " · Estudio"),
      h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "Salir")
    ),
    mbar(Math.round((s.total - faltan) / s.total * 100), (s.total - faltan) + " de " + s.total + " resueltas", s.streak > 1 ? "🔥 Racha de " + s.streak : "Racha: " + s.streak, s.t0),
    h("div", { class: "qlayout" },
      h("div", { class: "stack qmain" },
        questionBlock(q, 0, s.total, {
          picked: s.picked, revealed: s.rev ? t && { correct: t.correct } : null, verdict: s.result, extra,
          pct: Math.round(((s.total - faltan) / s.total) * 100),
          meta: s.repeat ? "Repetida" : "Nueva",
          onPick: (id) => { s.picked = id; render(); }
        }),
        h("div", { class: "row nav" },
          s.result
            ? h("div", { class: "mid" }, s.rev ? null : h("button", { class: "btn ghost", type: "button", onclick: (ev) => studyReveal(ev.currentTarget) }, "Ver respuesta"))
            : h("div", { class: "mid" },
                h("button", { class: "btn", type: "button", disabled: !s.picked || s.busy, onclick: (ev) => studyAnswer(ev.currentTarget) }, "Responder"),
                h("button", { class: "btn ghost", type: "button", onclick: (ev) => studyReveal(ev.currentTarget) }, "Ver respuesta")),
          s.result
            ? h("button", { class: "btn", type: "button", onclick: studyNext }, s.result === "ok" && faltan === 1 ? "Finalizar" : "Siguiente")
            : null
        )
      ),
      studyPanel(s, faltan)
    )
  );
}

/* Examen simulado: configuración */
function openSimCfg(exam) {
  const topics = exam.topics || [];
  state.simCfg = { exam, sel: new Set(topics.map((t) => t.name)), count: Math.min(20, exam.total) };
  go("simcfg");
}

function viewSimCfg() {
  const c = state.simCfg;
  const topics = c.exam.topics || [];
  const total = topics.length ? countOf(c.exam, c.sel) : c.exam.total;
  if (c.count > total) c.count = total;
  if (c.count < 1) c.count = 1;
  const opciones = [10, 20, 50].filter((n) => n < total).map((n) => ({ n, label: String(n) }));
  opciones.push({ n: total, label: total === 1 ? "1 pregunta" : "Todas (" + total + ")" });

  const seg = h("div", { class: "seg", role: "group", "aria-label": "Cantidad de preguntas" });
  for (const o of opciones) {
    seg.append(h("button", {
      type: "button", "aria-pressed": String(c.count === o.n),
      onclick: () => { c.count = o.n; render(); }
    }, o.label));
  }
  const entrada = h("input", {
    type: "number", min: "1", max: String(total), value: String(c.count), inputmode: "numeric", class: "num",
    "aria-label": "Cantidad de preguntas",
    onchange: (ev) => { const v = parseInt(ev.target.value, 10); c.count = Number.isFinite(v) ? Math.max(1, Math.min(total, v)) : c.count; render(); }
  });

  const k = c.sel.size;
  const aviso = topics.length > 1 && k > 1
    ? "Se tomarán preguntas al azar de " + k + " asignaturas, con una cantidad similar de cada una (aprox. " + Math.max(1, Math.floor(c.count / k)) + " por asignatura)."
    : "Las preguntas se eligen al azar.";

  return h("section", { class: "stack" },
    h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "← Volver")),
    h("div", { class: "card stack", style: "max-width:640px" },
      h("h1", { style: "font-size:clamp(22px,4vw,28px)" }, "Examen simulado"),
      h("p", { class: "muted" }, c.exam.title),
      topics.length > 1 ? h("div", {}, h("label", {}, "Asignaturas (una o más)"), subjectPicker(c.exam, c.sel, render)) : null,
      h("div", {}, h("label", {}, "¿Cuántas preguntas quieres responder? (máx. " + total + ")"),
        h("div", { class: "row" }, seg, entrada)),
      h("p", { class: "hint" }, aviso + " Verás las respuestas correctas y sus explicaciones al terminar."),
      h("button", { class: "btn", type: "button", onclick: (ev) => startSim(ev.currentTarget) }, "Comenzar examen")
    )
  );
}

async function startSim(btn) {
  const { exam, count, sel } = state.simCfg;
  const todas = !exam.topics || !exam.topics.length || sel.size === exam.topics.length;
  const topics = todas ? null : [...sel];
  btn.disabled = true;
  setNotice(null);
  try {
    const { data, error } = await sb.rpc("start_attempt_by_topics", { p_exam_id: exam.id, p_count: count, p_topics: topics });
    if (error) throw error;
    const qs = await loadQuestions(exam.id, data.question_ids);
    state.sim = { exam, attemptId: data.attempt_id, qs, i: 0, answers: {}, sent: {}, confirm: false, score: null, review: null, sel: new Set(sel), t0: Date.now() };
    go("sim");
  } catch (e) {
    btn.disabled = false;
    setNotice("err", errorText(e));
    render();
  }
}

/* Examen simulado: rendir */
function viewSim() {
  const s = state.sim;
  const q = s.qs[s.i];
  const ultima = s.i === s.qs.length - 1;
  const sinResponder = s.qs.filter((x) => !s.answers[x.id]).length;

  return h("section", { class: "stack" },
    h("div", { class: "row", style: "justify-content:space-between" },
      h("h1", { style: "font-size:clamp(20px,4vw,26px)" }, s.exam.title + " · Simulado"),
      h("button", { class: "btn ghost small", type: "button", onclick: () => { s.salir = true; render(); window.scrollTo(0, 0); } }, "Salir del examen")
    ),
    s.salir
      ? h("div", { class: "msg warn", role: "alert" },
          h("p", {}, "¿Salir del examen? Tu intento no se calificará y perderás tu avance."),
          h("div", { class: "row", style: "margin-top:10px" },
            h("button", { class: "btn small", type: "button", onclick: () => { state.sim = null; go("inicio"); } }, "Sí, salir"),
            h("button", { class: "btn ghost small", type: "button", onclick: () => { s.salir = false; render(); } }, "Seguir en el examen")))
      : null,
    mbar(Math.round((s.qs.length - sinResponder) / s.qs.length * 100), (s.qs.length - sinResponder) + "/" + s.qs.length + " respondidas", "Pregunta " + (s.i + 1) + " de " + s.qs.length, s.t0,
      h("button", { class: "btn small mgrid", type: "button", onclick: () => { s.sheet = true; render(); } }, "▦ Preguntas")),
    h("div", { class: "qlayout" },
      h("div", { class: "stack qmain", ontouchstart: swipeStart, ontouchend: (ev) => swipeEnd(ev, s) },
        questionBlock(q, s.i, s.qs.length, {
          picked: s.answers[q.id], revealed: null,
          onPick: (id) => { s.answers[q.id] = id; s.confirm = false; vibra(10); render(); }
        }),
        s.confirm
          ? h("div", { class: "msg warn", role: "status" },
              "Tienes " + plural(sinResponder, "pregunta sin responder", "preguntas sin responder") + ". Pulsa Finalizar de nuevo para terminar igual.")
          : null,
        h("div", { class: "row nav" },
          h("button", { class: "btn ghost", type: "button", disabled: s.i === 0, onclick: (ev) => simMove(-1, ev.currentTarget) }, "Anterior"),
          ultima
            ? h("button", { class: "btn", type: "button", onclick: (ev) => simFinish(ev.currentTarget) }, "Finalizar")
            : h("button", { class: "btn", type: "button", onclick: (ev) => simMove(1, ev.currentTarget) }, "Siguiente")
        )
      ),
      simPanel(s, sinResponder)
    ),
    s.sheet ? simSheet(s, sinResponder) : null
  );
}

let swipe0 = null;
function swipeStart(ev) { const t = ev.touches[0]; swipe0 = ev.target.closest("textarea,input") ? null : { x: t.clientX, y: t.clientY }; }
function swipeEnd(ev, s) {
  if (!swipe0) return;
  const t = ev.changedTouches[0], dx = t.clientX - swipe0.x, dy = t.clientY - swipe0.y;
  swipe0 = null;
  if (Math.abs(dx) < 80 || Math.abs(dy) > 50 || Math.abs(dx) < Math.abs(dy) * 2) return;
  const j = s.i + (dx < 0 ? 1 : -1);
  if (j < 0 || j >= s.qs.length) return;
  simGoto(j, {});
}

async function simGoto(idx, btn) {
  const s = state.sim;
  if (idx === s.i) return;
  btn.disabled = true;
  setNotice(null);
  try {
    await sendAnswer(s.qs[s.i].id);
    s.i = idx; s.confirm = false; s.sheet = false;
    render();
    window.scrollTo(0, 0);
  } catch (e) {
    setNotice("err", errorText(e));
    render();
  }
}

async function sendAnswer(qid) {
  const s = state.sim;
  const opt = s.answers[qid];
  if (!opt || s.sent[qid] === opt) return;
  const { error } = await sb.rpc("submit_answer", { p_attempt_id: s.attemptId, p_question_id: qid, p_option_id: opt });
  if (error) throw error;
  s.sent[qid] = opt;
}

async function simMove(delta, btn) {
  const s = state.sim;
  btn.disabled = true;
  setNotice(null);
  try {
    await sendAnswer(s.qs[s.i].id);
    s.i += delta;
    s.confirm = false;
    render();
    window.scrollTo(0, 0);
  } catch (e) {
    setNotice("err", errorText(e));
    render();
  }
}

async function simFinish(btn) {
  const s = state.sim;
  const sinResponder = s.qs.filter((x) => !s.answers[x.id]).length;
  if (sinResponder && !s.confirm) { s.confirm = true; render(); return; }
  btn.disabled = true;
  setNotice(null);
  try {
    for (const q of s.qs) await sendAnswer(q.id);
    const fin = await sb.rpc("finish_attempt", { p_attempt_id: s.attemptId });
    if (fin.error) throw fin.error;
    const rev = await sb.rpc("get_attempt_review", { p_attempt_id: s.attemptId });
    if (rev.error) throw rev.error;
    s.score = fin.data;
    s.review = rev.data || [];
    go("resultado");
  } catch (e) {
    setNotice("err", errorText(e));
    render();
  }
}


/* Reportar error en la respuesta correcta */
const reported = new Set();
const reporting = new Set();

function reportBox(questionId) {
  const caja = h("div", { class: "report" });
  const pintar = () => {
    caja.replaceChildren();
    if (reported.has(questionId)) {
      caja.append(h("span", { class: "report-ok" }, "Gracias, revisaremos esta respuesta."));
      return;
    }
    if (!reporting.has(questionId)) {
      caja.append(h("button", { type: "button", class: "report-link", onclick: () => { reporting.add(questionId); pintar(); } },
        "Reportar error en respuesta correcta"));
      return;
    }
    const nota = h("textarea", { rows: "2", maxlength: "500", placeholder: "¿Qué crees que está mal? (opcional)", "aria-label": "Comentario del reporte" });
    const msg = h("span", { class: "report-err", hidden: true });
    const enviar = h("button", { type: "button", class: "btn small", onclick: async () => {
      enviar.disabled = true; msg.hidden = true;
      const { error } = await sb.rpc("report_answer_error", { p_question_id: questionId, p_note: nota.value });
      if (error) { enviar.disabled = false; msg.textContent = errorText(error); msg.hidden = false; return; }
      reported.add(questionId); reporting.delete(questionId); pintar();
    } }, "Enviar reporte");
    const cancelar = h("button", { type: "button", class: "btn ghost small", onclick: () => { reporting.delete(questionId); pintar(); } }, "Cancelar");
    caja.append(nota, h("div", { class: "row" }, enviar, cancelar, msg));
  };
  pintar();
  return caja;
}

/* Cabina 3D A320 (prototipo privado): el contenido vive en la tabla privado_archivos; la RLS solo deja leerlo al dueño del proyecto */
const CABINA_UID = "760b27aa-3608-44a4-9772-cd4a7baec195";
const puedeCabina = () => !!(state.session && state.session.user && state.session.user.id === CABINA_UID);
async function openCabina() {
  if (!puedeCabina()) return;
  state.cabina = { html: null, error: null };
  go("cabina");
  const st = state.cabina;
  const { data, error } = await sb.from("privado_archivos").select("contenido").eq("nombre", "cabina_a320.html").maybeSingle();
  if (state.cabina !== st) return;
  if (error) st.error = errorText(error); else if (!data) st.error = "El prototipo aún no está cargado."; else st.html = data.contenido;
  if (state.view === "cabina") render();
}

/* El visor (iframe aislado) pide el modelo 3D; se arma desde las partes privadas y se le entrega */
let cabinaGlb = null;
async function cabinaModelo() {
  if (cabinaGlb) return cabinaGlb;
  const { data, error } = await sb.from("privado_archivos").select("nombre, contenido").like("nombre", "cabina_glb_%").order("nombre");
  if (error || !data || !data.length) throw error || new Error("Modelo no disponible");
  const bin = atob(data.map((r) => r.contenido).join(""));
  const buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  cabinaGlb = buf.buffer; return cabinaGlb;
}
window.addEventListener("message", async (ev) => {
  if (!ev.data || ev.data.type !== "pp-ready" || !puedeCabina()) return;
  const fr = document.querySelector(".cabinaframe"); if (!fr || ev.source !== fr.contentWindow) return;
  try { const buf = await cabinaModelo(); fr.contentWindow.postMessage({ type: "pp-glb", buf: buf.slice(0) }, "*"); } catch { /* el visor muestra el aviso de carga */ }
});

function viewCabina() {
  const st = state.cabina;
  if (!puedeCabina() || !st) return h("p", { class: "muted" }, "Sin acceso.");
  return h("div", { class: "stack" },
    h("div", { class: "row" },
      h("button", { class: "btn ghost small", type: "button", onclick: () => go(hasActive() ? "inicio" : "planes") }, "← Volver"),
      h("h2", {}, "Cabina A320 3D"), h("span", { class: "muted" }, "Prototipo privado")),
    st.error ? h("div", { class: "msg err", role: "alert" }, st.error)
      : st.html ? h("iframe", { class: "cabinaframe", title: "Cabina A320 3D", sandbox: "allow-scripts", allow: "fullscreen", srcdoc: st.html })
      : h("p", { class: "muted", role: "status" }, "Cargando cabina…"),
    h("p", { class: "muted", style: "font-size:12px" }, "Modelo 3D: “A320 Cockpit 2” por davidmarton1987 (Sketchfab), licencia CC BY 4.0."));
}

/* Administración: listado de reportes */
/* Panel de administración: usuarios */
function adminTabs(activa) {
  return h("div", { class: "row", style: "justify-content:space-between" },
    h("div", { class: "seg", role: "group", "aria-label": "Panel" },
      h("button", { type: "button", "aria-pressed": String(activa === "usuarios"), onclick: () => openUsuarios() }, "Usuarios"),
      h("button", { type: "button", "aria-pressed": String(activa === "reportes"), onclick: () => openReportes() }, "Reportes")),
    h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "← Inicio"));
}

async function openUsuarios() {
  state.users = { items: null, error: null };
  go("usuarios");
  const st = state.users;
  const [{ data, error }, cnt] = await Promise.all([sb.rpc("admin_list_users"), sb.rpc("admin_device_counts")]);
  if (state.users !== st) return;
  const dev = new Map((cnt.data || []).map((d) => [d.user_id, Number(d.devices)]));
  if (error) st.error = errorText(error); else st.items = (data || []).map((u) => ({ ...u, devices: dev.get(u.user_id) || 0 }));
  if (state.view === "usuarios") render();
}

async function adminTrial(u, nombre, btn) {
  btn.disabled = true;
  const { error } = await sb.rpc("admin_grant_trial", { p_user_id: u.user_id });
  if (error) { setNotice("err", errorText(error)); render(); return; }
  setNotice("ok", "Se dieron 24 horas de acceso gratis a " + nombre + " (solo Piloto Privado).");
  await openUsuarios();
  setNotice("ok", "Se dieron 24 horas de acceso gratis a " + nombre + " (solo Piloto Privado).");
  render();
}

async function toggleDevices(u) {
  const st = state.users;
  if (st.open === u.user_id) { st.open = null; render(); return; }
  st.open = u.user_id; st.devs = null; render();
  const { data, error } = await sb.rpc("admin_user_devices", { p_user_id: u.user_id });
  if (st.open !== u.user_id) return;
  st.devs = error ? [] : data || [];
  render();
}
function devicesList(st, u) {
  if (!st.devs) return h("span", { class: "hint" }, "Cargando…");
  return h("div", { class: "stack", style: "gap:4px;margin-top:6px" },
    st.devs.map((d) => h("span", { class: "hint" },
      (d.is_current ? "● " : "○ ") + (d.label || "Dispositivo") + " · visto " + agoText(new Date(d.last_seen).getTime()) + " · desde " + new Date(d.first_seen).toLocaleDateString("es-CL") + (d.is_current ? " · sesión activa" : ""))));
}

const ONLINE_MS = 150000;
function lastAccess(u) {
  const t = [u.last_sign_in_at, u.last_seen].filter(Boolean).map((x) => new Date(x).getTime());
  return t.length ? Math.max(...t) : null;
}
function agoText(ms) {
  if (ms == null) return "Sin acceso";
  const d = Date.now() - ms;
  if (d < 60000) return "hace un momento";
  const m = Math.floor(d / 60000);
  if (m < 60) return "hace " + m + " min";
  const hh = Math.floor(m / 60);
  if (hh < 24) return "hace " + hh + " h";
  const dd = Math.floor(hh / 24);
  if (dd < 30) return "hace " + dd + (dd === 1 ? " día" : " días");
  return new Date(ms).toLocaleDateString("es-CL");
}

function viewUsuarios() {
  const st = state.users || { items: null };
  const lista = h("div", { class: "review" });
  if (st.error) lista.append(h("div", { class: "msg err" }, st.error));
  else if (!st.items) lista.append(loader());
  else if (!st.items.length) lista.append(h("div", { class: "card empty" }, h("p", { class: "muted" }, "Aún no hay usuarios.")));
  else for (const u of st.items) {
    const la = lastAccess(u);
    const online = u.last_seen && Date.now() - new Date(u.last_seen).getTime() < ONLINE_MS;
    const nombre = u.display_name || (u.email || "").split("@")[0];
    const ok = Number(u.correct), mal = Number(u.incorrect);
    lista.append(h("article", { class: "card urow" },
      h("div", { class: "avatar" + (online ? " online" : ""), title: online ? "En línea" : "Desconectado" }, (nombre || "?").charAt(0).toUpperCase()),
      h("div", { class: "uinfo" },
        h("b", {}, nombre),
        h("span", { class: "muted" }, u.email),
        h("div", { class: "row", style: "gap:6px;margin-top:4px" },
          (u.plans && u.plans.length ? u.plans : ["Sin plan"]).map((p) => h("span", { class: "tag" + (u.plans && u.plans.length ? " ok" : "") }, p))),
        h("span", { class: "hint" }, (online ? "En línea ahora" : "Último acceso: " + agoText(la)) + " · Registrado: " + new Date(u.created_at).toLocaleDateString("es-CL")),
        u.devices ? h("button", { class: "tag" + (u.devices >= 3 ? " warn" : ""), type: "button", style: "cursor:pointer;margin-top:4px;align-self:flex-start",
          onclick: () => toggleDevices(u) }, "📱 " + plural(u.devices, "dispositivo", "dispositivos") + (u.devices >= 3 ? " · revisar" : "")) : null,
        st.open === u.user_id ? devicesList(st, u) : null
      ),
      h("div", { class: "ustats" },
        (u.plans && u.plans.length) ? null
          : h("button", { class: "btn ghost small", type: "button", onclick: (ev) => adminTrial(u, nombre, ev.currentTarget) }, "Dar 24 h gratis"),
        h("b", {}, String(ok + mal)),
        h("span", { class: "muted" }, "respondidas"),
        h("span", { class: "hint" }, "✔ " + ok + " · ✖ " + mal))
    ));
  }
  return h("section", { class: "stack" },
    adminTabs("usuarios"),
    h("div", { class: "row", style: "justify-content:space-between" },
      h("h1", { style: "font-size:clamp(22px,4vw,28px)" }, "Usuarios" + (st.items ? " (" + st.items.length + ")" : "")),
      h("button", { class: "btn ghost small", type: "button", onclick: () => openUsuarios() }, "Actualizar")),
    lista);
}

async function openReportes(status) {
  state.reports = { status: status || "abierto", items: null, error: null };
  go("reportes");
  const st = state.reports;
  const { data, error } = await sb.rpc("admin_list_reports", { p_status: st.status });
  if (state.reports !== st) return;
  if (error) st.error = errorText(error); else st.items = data || [];
  render();
}

async function resolveReports(item, status, verify) {
  const { error } = await sb.rpc("admin_resolve_reports", { p_question_id: item.question_id, p_status: status, p_verify: verify });
  if (error) { setNotice("err", errorText(error)); render(); return; }
  setNotice(null);
  openReportes(state.reports.status);
}

function viewReportes() {
  const st = state.reports || { status: "abierto", items: null };
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Estado" });
  for (const [v, l] of [["abierto", "Abiertos"], ["resuelto", "Resueltos"], ["descartado", "Descartados"]]) {
    seg.append(h("button", { type: "button", "aria-pressed": String(st.status === v), onclick: () => openReportes(v) }, l));
  }
  const lista = h("div", { class: "review" });
  if (st.error) lista.append(h("div", { class: "msg err" }, st.error));
  else if (!st.items) lista.append(loader());
  else if (!st.items.length) lista.append(h("div", { class: "card empty" }, h("p", { class: "muted" }, "No hay reportes en este estado.")));
  else for (const it of st.items) {
    const ops = h("div", { class: "opts" });
    for (const o of it.options || []) {
      ops.append(h("div", { class: "opt" + (o.is_correct ? " correct" : ""), style: "cursor:default" },
        h("span", { class: "lt" }, o.label), h("span", {}, o.text)));
    }
    const notas = (it.reports || []).filter((r) => r.note).map((r) => h("li", {}, r.note));
    lista.append(h("article", { class: "card stack" },
      h("div", { class: "row" },
        h("span", { class: "tag" }, (it.topic || "") + " · N.º " + (it.position ?? "")),
        h("span", { class: "tag bad" }, plural(it.count, "reporte", "reportes")),
        h("span", { class: "tag" }, "Estado: " + it.answer_status + (it.confidence ? " (" + it.confidence + ")" : ""))),
      h("h2", { class: "qtext" }, it.statement),
      ops,
      h("div", { class: "explain" }, h("b", {}, "Explicación actual"), h("p", {}, it.explanation || "—")),
      it.review_note ? h("p", { class: "hint" }, "Nota interna: " + it.review_note) : null,
      notas.length ? h("div", {}, h("b", {}, "Comentarios de alumnos"), h("ul", {}, notas)) : null,
      st.status === "abierto" ? h("div", { class: "row" },
        h("button", { class: "btn small", type: "button", onclick: () => resolveReports(it, "resuelto", true) }, "Resuelto y verificada"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => resolveReports(it, "resuelto", false) }, "Resuelto"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => resolveReports(it, "descartado", false) }, "Descartar")
      ) : null
    ));
  }
  return h("section", { class: "stack" },
    adminTabs("reportes"),
    h("h1", { style: "font-size:clamp(22px,4vw,28px)" }, "Reportes de respuestas"),
    seg, lista);
}

/* Resultado */
function viewResultado() {
  const s = state.sim;
  const total = s.qs.length;
  const pct = total ? Math.round((s.score / total) * 100) : 0;

  const items = h("div", { class: "review" });
  const resumen = h("div", { class: "card summary" });
  resumen.append(h("h2", {}, "Resumen de tus respuestas"));
  const tabla = h("div", { class: "sumlist" });
  let nro = 0;
  for (const r of s.review) {
    const q = s.qs.find((x) => x.id === r.question_id);
    if (!q) continue;
    nro++;
    const n = nro;
    const el = q.options.find((o) => o.id === r.chosen_option_id);
    const co = q.options.find((o) => o.id === r.correct_option_id);
    const cls = !el ? "none" : r.is_correct ? "ok" : "bad";
    tabla.append(h("button", { type: "button", class: "sumrow " + cls, onclick: () => { const t = document.getElementById("pq" + n); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); } },
      h("span", { class: "sn" }, String(n)),
      h("span", { class: "sq" }, q.statement.length > 110 ? q.statement.slice(0, 107) + "…" : q.statement),
      h("span", { class: "sa" }, h("b", {}, el ? el.label : "—"), h("span", { class: "muted" }, " → "), h("b", {}, co ? co.label : "—"), h("span", { class: "mark" }, !el ? "·" : r.is_correct ? "✔" : "✖"))));
  }
  resumen.append(tabla, h("p", { class: "hint" }, "Cada fila muestra tu respuesta → la correcta. Toca una fila para ir a su explicación."));
  nro = 0;
  for (const r of s.review) {
    const q = s.qs.find((x) => x.id === r.question_id);
    if (!q) continue;
    nro++;
    const elegida = q.options.find((o) => o.id === r.chosen_option_id);
    const correcta = q.options.find((o) => o.id === r.correct_option_id);
    const estado = !elegida ? ["", "Sin responder"] : r.is_correct ? ["ok", "Correcta"] : ["bad", "Incorrecta"];
    items.append(h("article", { class: "card", id: "pq" + nro },
      h("span", { class: "tag " + estado[0] }, "Pregunta " + nro + " · " + estado[1]),
      h("h2", { class: "qtext", style: "margin-top:8px" }, q.statement),
      figuresBlock(q),
      h("p", { class: "answer" }, h("b", {}, "Tu respuesta: "), elegida ? elegida.label + ". " + elegida.text : "—"),
      h("p", { class: "answer" }, h("b", {}, "Correcta: "), correcta ? correcta.label + ". " + correcta.text : "—"),
      h("div", { class: "explain" },
        h("b", {}, "Explicación"),
        h("p", {}, r.explanation || "Esta pregunta no tiene explicación todavía."),
        reportBox(q.id))
    ));
  }

  return h("section", { class: "stack" },
    h("div", { class: "score" },
      h("div", { class: "big" }, s.score + "/" + total),
      h("div", {}, h("h2", {}, pct + "% de respuestas correctas"), h("span", {}, s.exam.title))
    ),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", onclick: () => go("inicio") }, "Volver al inicio"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { state.simCfg = { exam: s.exam, sel: new Set(s.sel), count: total }; go("simcfg"); } }, "Repetir examen"),
      h("button", { class: "btn share", type: "button", onclick: () => { s.share = s.share || { fmt: "story", name: false }; s.share.open = !s.share.open; render(); } }, "📸 Compartir mi resultado en Instagram")
    ),
    s.share && s.share.open ? sharePanel(s) : null,
    resumen,
    items
  );
}

/* ---------- Compartir resultado (imagen) ---------- */

function statsResultado(s) {
  const total = s.qs.length;
  let ok = 0, mal = 0, sin = 0;
  const porTema = new Map();
  for (const r of s.review) {
    const q = s.qs.find((x) => x.id === r.question_id);
    if (!q) continue;
    const el = q.options.find((o) => o.id === r.chosen_option_id);
    const t = q.topic || "General";
    const a = porTema.get(t) || { ok: 0, n: 0 };
    a.n++;
    if (!el) sin++; else if (r.is_correct) { ok++; a.ok++; } else mal++;
    porTema.set(t, a);
  }
  const pct = total ? (ok / total) * 100 : 0;
  return { total, ok, mal, sin, pct, temas: [...porTema].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.n - a.n) };
}

function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function wrapText(ctx, text, maxW) {
  const words = text.split(" "); const lines = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}
function loadImg(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }

async function drawShare(canvas, s, opts) {
  const W = 1080, H = opts.fmt === "story" ? 1920 : 1350;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const st = statsResultado(s);
  const FONT = '"Plus Jakarta Sans", system-ui, sans-serif';
  try { await Promise.all([800, 700, 500].map((w) => document.fonts.load(w + " 40px " + FONT))); } catch {}
  const logo = await loadImg("img/logo.webp");

  // fondo
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, "#0B1220"); g.addColorStop(0.55, "#1B1F5C"); g.addColorStop(1, "#4338CA");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // cartas de navegación (círculos concéntricos)
  ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 2;
  for (let r = 160; r < 1500; r += 150) { ctx.beginPath(); ctx.arc(W * 0.85, H * 0.28, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(0, H * 0.28 + 90); ctx.lineTo(W, H * 0.28 - 160); ctx.stroke();

  const story = opts.fmt === "story";
  const P = story
    ? { top: 90, logoW: 330, afterLogo: 50, titleSz: 52, R: 200, ringLw: 40, cards: true, pillH: 70, gapMsg: 44, footer: 210 }
    : { top: 56, logoW: 210, afterLogo: 34, titleSz: 46, R: 140, ringLw: 32, cards: false, pillH: 60, gapMsg: 36, footer: 150 };
  let y = P.top;
  // logo
  if (logo) {
    const lw = P.logoW, lh = lw * logo.height / logo.width, lx = (W - lw) / 2;
    ctx.save(); rr(ctx, lx, y, lw, lh, 30); ctx.clip(); ctx.drawImage(logo, lx, y, lw, lh); ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 3; rr(ctx, lx, y, lw, lh, 30); ctx.stroke();
    y += lh + P.afterLogo;
  }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  const quien = opts.name && state.name ? "RESULTADO DE " + state.name.split(" ")[0].toUpperCase() : "MI RESULTADO";
  ctx.fillStyle = "#A5B4FC"; ctx.font = "700 " + (story ? 32 : 28) + "px " + FONT;
  ctx.fillText(quien + " · EXAMEN SIMULADO", W / 2, y + 28); y += 28;
  ctx.fillStyle = "#fff"; ctx.font = "800 " + P.titleSz + "px " + FONT;
  const lines = wrapText(ctx, s.exam.title, W - 140).slice(0, 2);
  for (const l of lines) { y += P.titleSz + 14; ctx.fillText(l, W / 2, y); }
  y += story ? 44 : 30;

  // anillo
  const R = P.R, cy = y + R + 16, cx = W / 2;
  ctx.lineWidth = P.ringLw; ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,.14)"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  const aprobo = st.pct >= 60;
  const ring = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  ring.addColorStop(0, aprobo ? "#34D399" : "#F2BD55"); ring.addColorStop(1, aprobo ? "#A7F3D0" : "#FDE68A");
  ctx.strokeStyle = ring;
  if (st.pct > 0) { ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (st.pct / 100)); ctx.stroke(); }
  ctx.fillStyle = "#fff"; ctx.font = "800 " + (R * 0.6) + "px " + FONT; ctx.fillText(Math.round(st.pct) + "%", cx, cy + R * 0.1);
  ctx.fillStyle = "#C7D2FE"; ctx.font = "600 " + (R * 0.16) + "px " + FONT; ctx.fillText(st.ok + " de " + st.total + " correctas", cx, cy + R * 0.4);
  y = cy + R + (story ? 92 : 70);

  // mensaje
  const msg = st.pct >= 90 ? "¡Vuelo impecable!" : st.pct >= 75 ? "¡Aterrizaje seguro!" : st.pct >= 60 ? "Aprobado: sigo practicando" : "En entrenamiento: voy por más";
  ctx.fillStyle = "#fff"; ctx.font = "700 " + (story ? 38 : 34) + "px " + FONT; ctx.fillText(msg, W / 2, y); y += story ? 54 : 40;

  // aciertos
  if (P.cards) {
    const cw = 290, gap = 24, x0 = (W - (cw * 3 + gap * 2)) / 2;
    [["Correctas", st.ok, "#34D399"], ["Incorrectas", st.mal, "#F87171"], ["Sin responder", st.sin, "#A7B3C6"]].forEach(([lab, val, col], i) => {
      const x = x0 + i * (cw + gap);
      ctx.fillStyle = "rgba(255,255,255,.09)"; rr(ctx, x, y, cw, 120, 26); ctx.fill();
      ctx.fillStyle = col; ctx.font = "800 54px " + FONT; ctx.fillText(String(val), x + cw / 2, y + 64);
      ctx.fillStyle = "#C7D2FE"; ctx.font = "600 25px " + FONT; ctx.fillText(lab, x + cw / 2, y + 100);
    });
    y += 120 + 46;
  } else {
    ctx.font = "700 30px " + FONT;
    const partes = [[st.ok + " correctas", "#34D399"], [st.mal + " incorrectas", "#F87171"], [st.sin + " sin responder", "#A7B3C6"]];
    const sep = "   ·   "; const total = partes.map((p) => ctx.measureText(p[0]).width).reduce((a, b) => a + b, 0) + ctx.measureText(sep).width * 2;
    let x = (W - total) / 2; ctx.textAlign = "left";
    partes.forEach((p, i) => { ctx.fillStyle = p[1]; ctx.fillText(p[0], x, y); x += ctx.measureText(p[0]).width; if (i < 2) { ctx.fillStyle = "#6B7AA8"; ctx.fillText(sep, x, y); x += ctx.measureText(sep).width; } });
    ctx.textAlign = "center"; y += 44;
  }

  // contenidos (los que quepan sobre el pie)
  const footerTop = H - P.footer;
  const rowH = 78, headH = 44;
  const cupo = Math.max(0, Math.min(story ? 7 : 4, Math.floor((footerTop - y - headH) / rowH)));
  if (cupo > 0) {
    ctx.textAlign = "left"; ctx.fillStyle = "#A5B4FC"; ctx.font = "700 28px " + FONT;
    ctx.fillText("CONTENIDOS EVALUADOS", 90, y + 10); y += headH - 14;
    const resto = st.temas.length - cupo;
    const mostrar = resto > 0 ? st.temas.slice(0, cupo - 1) : st.temas.slice(0, cupo);
    for (const t of mostrar) {
      y += 38;
      ctx.fillStyle = "#fff"; ctx.font = "600 29px " + FONT;
      let nm = t.name; while (ctx.measureText(nm).width > 700 && nm.length > 4) nm = nm.slice(0, -2);
      if (nm !== t.name) nm = nm.trim() + "…";
      ctx.fillText(nm, 90, y);
      ctx.textAlign = "right"; ctx.fillStyle = "#C7D2FE"; ctx.fillText(t.ok + "/" + t.n, W - 90, y); ctx.textAlign = "left";
      y += 14;
      ctx.fillStyle = "rgba(255,255,255,.14)"; rr(ctx, 90, y, W - 180, 13, 7); ctx.fill();
      if (t.n && t.ok) { ctx.fillStyle = t.ok / t.n >= 0.6 ? "#34D399" : "#F2BD55"; rr(ctx, 90, y, Math.max(13, (W - 180) * t.ok / t.n), 13, 7); ctx.fill(); }
      y += 26;
    }
    if (resto > 0) { y += 30; ctx.fillStyle = "#A7B3C6"; ctx.font = "500 26px " + FONT; ctx.fillText("+ " + (resto + 1) + " asignaturas más", 90, y); }
  }

  // pie
  ctx.textAlign = "center";
  const fy = H - (story ? 120 : 76);
  ctx.fillStyle = "#fff"; ctx.font = "800 " + (story ? 44 : 38) + "px " + FONT; ctx.fillText("Practica tú también en pilotprep.cl", W / 2, fy);
  ctx.fillStyle = "#A5B4FC"; ctx.font = "600 " + (story ? 28 : 26) + "px " + FONT; ctx.fillText("Aprender · Practicar · Aprobar", W / 2, fy + 44);
}

function sharePanel(s) {
  const sh = s.share;
  const canvas = h("canvas", { class: "sharecv", "aria-label": "Vista previa de tu resultado" });
  const redraw = () => drawShare(canvas, s, { fmt: sh.fmt, name: sh.name });
  redraw();
  const toBlob = () => new Promise((res) => canvas.toBlob(res, "image/png"));
  const archivo = "pilotprep-resultado.png";
  const msg = h("p", { class: "hint", role: "status", hidden: true });
  const compartir = async () => {
    const blob = await toBlob(); if (!blob) return;
    const f = new File([blob], archivo, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: "Mi resultado en PilotPrep", text: "Mi resultado en PilotPrep.cl" }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    descargar();
  };
  const descargar = async () => {
    const blob = await toBlob(); if (!blob) return;
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = archivo; document.body.append(a); a.click(); a.remove();
    msg.textContent = "Imagen descargada. Súbela a Instagram desde tu galería."; msg.hidden = false;
  };
  const seg = (fmt, txt) => h("button", { type: "button", "aria-pressed": String(sh.fmt === fmt), onclick: () => { sh.fmt = fmt; render(); } }, txt);
  const nombre = h("input", { id: "shname", type: "checkbox", class: "chk" }); nombre.checked = sh.name;
  nombre.addEventListener("change", () => { sh.name = nombre.checked; redraw(); });
  return h("div", { class: "card stack sharebox" },
    h("h2", {}, "Tu resultado para Instagram"),
    h("div", { class: "seg", role: "group", "aria-label": "Formato" }, seg("story", "Historia 9:16"), seg("post", "Publicación 4:5")),
    h("div", { class: "sharewrap" }, canvas),
    h("label", { for: "shname", class: "chk-label" }, nombre, "Incluir mi nombre"),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", onclick: compartir }, "Compartir"),
      h("button", { class: "btn ghost", type: "button", onclick: descargar }, "Descargar imagen")),
    msg
  );
}

/* ---------- arranque ---------- */

sb.auth.onAuthStateChange((evento, session) => {
  if (evento === "PASSWORD_RECOVERY") {
    state.recovery = true;
    if (session) state.session = session;
    setTimeout(() => go("recuperar"), 0);
    return;
  }
  if (evento === "TOKEN_REFRESHED" || evento === "USER_UPDATED") {
    if (session) state.session = session;
    return;
  }
  if (state.recovery) return;
  const mismoUsuario = session && state.session && state.session.user.id === session.user.id;
  if (mismoUsuario) {
    state.session = session;
    const sid = sessionIdOf(session);
    if (sid && safe(() => authStorage.getItem("pp_sid"), null) !== sid) setTimeout(() => reclamarSesion(session), 0);
    return;
  }
  // Se evita llamar a Supabase dentro del callback para no bloquear el cliente.
  setTimeout(() => loadAccount(session), 0);
});

render();
const { data: { session: inicial } } = await sb.auth.getSession();
if (state.view === "cargando") loadAccount(inicial);
