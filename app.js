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

const activeSlugs = () => new Set(state.ents.filter((e) => e.status === "active").map((e) => e.plans.slug));
const hasActive = () => state.ents.some((e) => e.status === "active");
const pendingEnt = () => state.ents.find((e) => e.status === "pending");
const plural = (n, uno, otros) => n + " " + (n === 1 ? uno : otros);

function setNotice(type, text) {
  state.notice = text ? { type, text } : null;
}

function go(view, notice) {
  state.view = view;
  state.notice = notice || null;
  render();
  window.scrollTo(0, 0);
}

/* ---------- datos ---------- */

async function refreshEnts() {
  const { data } = await sb.from("entitlements").select("status, plans(slug,name)");
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

let presenceTimer = null;
function startPresence(on) {
  clearInterval(presenceTimer); presenceTimer = null;
  if (!on) return;
  const ping = () => { if (document.visibilityState === "visible") sb.rpc("touch_presence").then(() => {}, () => {}); };
  ping();
  presenceTimer = setInterval(ping, 60000);
}
document.addEventListener("visibilitychange", () => { if (presenceTimer && document.visibilityState === "visible") sb.rpc("touch_presence").then(() => {}, () => {}); });

let loadSeq = 0;
async function loadAccount(session) {
  const mine = ++loadSeq;
  state.session = session;
  if (state.recovery && session) { go("recuperar"); return; }
  if (state.recovery && !session) state.recovery = false;
  startPresence(!!session);
  if (!session) {
    state.name = ""; state.ents = []; state.exams = []; state.study = null; state.sim = null; state.simCfg = null; state.studyCfg = null; state.isAdmin = false; state.reports = null;
    go("visitante");
    return;
  }
  state.view = "cargando";
  render();
  const user = session.user;
  state.name = (user.user_metadata && user.user_metadata.display_name) || (user.email || "").split("@")[0];
  try {
    const catalogo = loadExams();
    const [prof, ents, plans, adm] = await Promise.all([
      sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
      sb.from("entitlements").select("status, plans(slug,name)"),
      sb.from("plans")
        .select("slug,name,description,price_amount,currency,upgrade_from_plan_id,upgrade_price_amount,sort_order")
        .order("sort_order"),
      sb.rpc("is_admin")
    ]);
    if (mine !== loadSeq) return;
    if (prof.data && prof.data.display_name) state.name = prof.data.display_name;
    state.ents = (ents.data || []).filter((e) => e.plans);
    state.plans = plans.data || [];
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
    if (hasActive()) {
      const ok = await catalogo;
      if (mine !== loadSeq) return;
      go("inicio", ok ? aviso : { type: "err", text: "No se pudieron cargar los exámenes." });
    } else {
      go("planes", aviso);
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
    recuperar: viewRecuperar, reportes: viewReportes, estcfg: viewEstCfg, estudio: viewEstudio, simcfg: viewSimCfg, sim: viewSim, resultado: viewResultado
  };
  app.append((vistas[state.view] || viewVisitante)());
}

function topbar() {
  const inicial = (state.name || "?").trim().charAt(0).toUpperCase();
  return h("header", { class: "topbar" },
    h("button", { class: "brand", type: "button", "aria-label": "PilotPrep, ir al inicio", onclick: () => go(hasActive() ? "inicio" : "planes") },
      h("img", { src: "img/icon.png", alt: "", width: "36", height: "36" }), h("span", {}, "PilotPrep")),
    h("div", { class: "user" },
      h("button", { class: "userlink" + (state.view === "cuenta" ? " on" : ""), type: "button", "aria-label": "Mi cuenta", title: "Mi cuenta", onclick: () => go("cuenta") },
        h("span", { class: "avatar", "aria-hidden": "true" }, inicial),
        h("span", { class: "uname" }, state.name)),
      state.isAdmin ? h("button", { class: "btn ghost small", type: "button", onclick: () => openUsuarios() }, "Panel") : null,
      h("button", { class: "btn ghost small", type: "button", onclick: () => sb.auth.signOut() }, "Cerrar sesión")
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
function viewCuenta() {
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
      const { error: e1 } = await sb.auth.signInWithPassword({ email, password: actual.value });
      if (e1) { mostrar("err", "La contraseña actual no es correcta."); return; }
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
  return h("section", { class: "stack" },
    h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => go(hasActive() ? "inicio" : "planes") }, "← Volver")),
    h("h1", {}, "Mi cuenta"),
    h("div", { class: "card" },
      h("p", { style: "font-weight:600" }, state.name),
      h("p", { class: "muted" }, email)),
    plansSection(true),
    h("div", { class: "card", style: "max-width:460px" }, h("h2", { style: "margin-bottom:12px" }, "Cambiar contraseña"), form)
  );
}

/* Planes */
function viewPlanes() { return plansSection(false); }

function plansSection(enCuenta) {
  const activos = activeSlugs();
  const tieneBase = activos.has("piloto-privado");
  const amplia = hasActive();
  const sec = h("section", { class: "stack" });

  sec.append(
    h("div", {},
      enCuenta ? h("h2", {}, amplia ? "Mis planes y ampliación" : "Planes") : h("h1", {}, "Elige tu plan"),
      h("p", { class: "muted", style: "margin-top:6px" },
        amplia ? "Suma más exámenes a tu cuenta." : "Para empezar, elige el plan que quieres comprar.")
    )
  );

  const grid = h("div", { class: "plans" });
  for (const plan of state.plans) {
    const activo = activos.has(plan.slug);
    const esAmpliacion = !activo && tieneBase && !!plan.upgrade_from_plan_id;
    const precio = esAmpliacion ? fmtPrice(plan.upgrade_price_amount, plan.currency) : fmtPrice(plan.price_amount, plan.currency);

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
      h("div", { class: "price" }, precio),
      ahorro,
      boton
    ));
  }
  sec.append(grid);
  return sec;
}

async function choosePlan(slug, btn) {
  btn.disabled = true;
  safe(() => sessionStorage.setItem("kb_before", String(activeSlugs().size)));
  const txt = btn.textContent;
  btn.textContent = "Redirigiendo a Mercado Pago…";
  setNotice(null);
  try {
    const { data, error } = await sb.functions.invoke("create-payment", { body: { plan_slug: slug } });
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

  if (!state.exams.length) {
    sec.append(h("div", { class: "card empty" }, h("p", { class: "muted" }, "Todavía no hay exámenes disponibles en tu cuenta.")));
  } else {
    const grid = h("div", { class: "exams" });
    for (const ex of state.exams) {
      const vacio = ex.total === 0;
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
    h("div", { class: "qmeta" }, (opts.meta || "Pregunta " + (i + 1) + " de " + total) + (q.topic ? " · " + q.topic : "")),
    h("h2", { class: "qtext" }, q.statement),
    figuresBlock(q),
    lista,
    opts.extra || null
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
    state.study = { exam, pending: qs, total: qs.length, firstTry: new Set(), failed: new Set(), truth: {}, picked: null, result: null, rev: false, busy: false, attempts: 0, repeat: false };
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
    if (s.result === "ok") { if (!s.failed.has(q.id)) s.firstTry.add(q.id); } else s.failed.add(q.id);
  } catch (e) { setNotice("err", errorText(e)); }
  s.busy = false; render();
}

async function studyReveal(btn) {
  const s = state.study; const q = s.pending[0];
  btn.disabled = true; setNotice(null);
  try {
    await studyTruth(q);
    s.rev = true;
    if (!s.result) { s.result = "bad"; s.failed.add(q.id); }
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
      h("div", { class: "row" },
        h("span", { class: "tag" }, "Por resolver: " + faltan + " de " + s.total),
        h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "Salir"))
    ),
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
    state.sim = { exam, attemptId: data.attempt_id, qs, i: 0, answers: {}, sent: {}, confirm: false, score: null, review: null, sel: new Set(sel) };
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
      h("span", { class: "tag" }, "Respondidas " + (s.qs.length - sinResponder) + "/" + s.qs.length)
    ),
    questionBlock(q, s.i, s.qs.length, {
      picked: s.answers[q.id], revealed: null,
      onPick: (id) => { s.answers[q.id] = id; s.confirm = false; render(); }
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
  );
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
  const { data, error } = await sb.rpc("admin_list_users");
  if (state.users !== st) return;
  if (error) st.error = errorText(error); else st.items = data || [];
  if (state.view === "usuarios") render();
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
        h("span", { class: "hint" }, (online ? "En línea ahora" : "Último acceso: " + agoText(la)) + " · Registrado: " + new Date(u.created_at).toLocaleDateString("es-CL"))
      ),
      h("div", { class: "ustats" },
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
  for (const r of s.review) {
    const q = s.qs.find((x) => x.id === r.question_id);
    if (!q) continue;
    const elegida = q.options.find((o) => o.id === r.chosen_option_id);
    const correcta = q.options.find((o) => o.id === r.correct_option_id);
    const estado = !elegida ? ["", "Sin responder"] : r.is_correct ? ["ok", "Correcta"] : ["bad", "Incorrecta"];
    items.append(h("article", { class: "card" },
      h("span", { class: "tag " + estado[0] }, estado[1]),
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
      h("button", { class: "btn ghost", type: "button", onclick: () => { state.simCfg = { exam: s.exam, sel: new Set(s.sel), count: total }; go("simcfg"); } }, "Repetir examen")
    ),
    items
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
  if (mismoUsuario) { state.session = session; return; }
  // Se evita llamar a Supabase dentro del callback para no bloquear el cliente.
  setTimeout(() => loadAccount(session), 0);
});

render();
const { data: { session: inicial } } = await sb.auth.getSession();
if (state.view === "cargando") loadAccount(inicial);
