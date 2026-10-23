import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const sb = createClient(
  "https://avrblfgwhofyzaceozew.supabase.co",
  "sb_publishable_x0nCCmOIH81eaQn5WrbZLg_sx0itqFb"
);

const app = document.getElementById("app");

const state = {
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
  const { data, error } = await sb.from("exams").select("id,slug,title,description").order("title");
  if (error) { state.exams = []; return false; }
  const counts = await Promise.all(
    (data || []).map((e) => sb.from("questions").select("id", { count: "exact", head: true }).eq("exam_id", e.id))
  );
  state.exams = (data || []).map((e, i) => ({ ...e, total: counts[i].count ?? 0 }));
  return true;
}

async function loadQuestions(examId, ids) {
  let q = sb.from("questions")
    .select("id,statement,topic,position,created_at,options(id,label,text)")
    .eq("exam_id", examId);
  if (ids) q = q.in("id", ids);
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

let loadSeq = 0;
async function loadAccount(session) {
  const mine = ++loadSeq;
  state.session = session;
  if (!session) {
    state.name = ""; state.ents = []; state.exams = []; state.study = null; state.sim = null; state.simCfg = null;
    go("visitante");
    return;
  }
  state.view = "cargando";
  render();
  const user = session.user;
  state.name = (user.user_metadata && user.user_metadata.display_name) || (user.email || "").split("@")[0];
  try {
    const [prof, ents, plans] = await Promise.all([
      sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
      sb.from("entitlements").select("status, plans(slug,name)"),
      sb.from("plans")
        .select("slug,name,description,price_amount,currency,upgrade_from_plan_id,upgrade_price_amount,sort_order")
        .order("sort_order")
    ]);
    if (mine !== loadSeq) return;
    if (prof.data && prof.data.display_name) state.name = prof.data.display_name;
    state.ents = (ents.data || []).filter((e) => e.plans);
    state.plans = plans.data || [];
    if (hasActive()) {
      const ok = await loadExams();
      if (mine !== loadSeq) return;
      go("inicio", ok ? null : { type: "err", text: "No se pudieron cargar los exámenes." });
    } else {
      go("planes");
    }
  } catch {
    if (mine !== loadSeq) return;
    go("planes", { type: "err", text: "No se pudo cargar tu cuenta. Recarga la página." });
  }
}

/* ---------- vistas ---------- */

function render() {
  app.replaceChildren();
  if (state.view === "cargando") {
    app.append(h("p", { class: "muted" }, "Cargando…"));
    return;
  }
  if (state.session && state.view !== "visitante") app.append(topbar());
  if (state.notice) app.append(h("div", { class: "msg " + state.notice.type, role: "status" }, state.notice.text));
  const vistas = {
    visitante: viewVisitante, planes: viewPlanes, inicio: viewInicio,
    estudio: viewEstudio, simcfg: viewSimCfg, sim: viewSim, resultado: viewResultado
  };
  app.append((vistas[state.view] || viewVisitante)());
}

function topbar() {
  const inicial = (state.name || "?").trim().charAt(0).toUpperCase();
  return h("header", { class: "topbar" },
    h("div", { class: "brand" }, "Knowledge Base"),
    h("div", { class: "user" },
      h("div", { class: "avatar", "aria-hidden": "true" }, inicial),
      h("span", { class: "uname" }, state.name),
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

  const mostrar = (tipo, texto) => { msg.className = "msg inline " + tipo; msg.textContent = texto; msg.hidden = false; };

  function setModo(nuevo) {
    modo = nuevo;
    const alta = modo === "signup";
    tabLogin.setAttribute("aria-selected", String(!alta));
    tabSignup.setAttribute("aria-selected", String(alta));
    campoNombre.hidden = !alta;
    hintClave.hidden = !alta;
    clave.autocomplete = alta ? "new-password" : "current-password";
    enviar.textContent = alta ? "Crear cuenta" : "Ingresar";
    msg.hidden = true;
  }
  tabLogin.addEventListener("click", () => setModo("login"));
  tabSignup.addEventListener("click", () => setModo("signup"));

  const form = h("form", { novalidate: true },
    campoNombre,
    h("div", { class: "field" }, h("label", { for: "correo" }, "Correo"), correo),
    h("div", { class: "field" }, h("label", { for: "clave" }, "Contraseña"), clave, hintClave),
    enviar, msg
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.hidden = true;
    const email = correo.value.trim();
    const password = clave.value;
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
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      mostrar("err", errorText(err));
    } finally {
      enviar.disabled = false;
    }
  });

  const irA = (m) => { setModo(m); correo.focus(); };

  return h("div", { class: "stack" },
    h("section", { class: "hero" },
      h("div", {},
        h("div", { class: "eyebrow" }, "Bancos de preguntas"),
        h("h1", {}, "Estudia y resuelve exámenes a tu medida"),
        h("p", {}, "Elige cuántas preguntas quieres responder y revisa la explicación de cada respuesta correcta."),
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", onclick: () => irA("signup") }, "Crear cuenta"),
          h("button", { class: "btn ghost", type: "button", onclick: () => irA("login") }, "Ingresar")
        )
      ),
      h("div", { class: "kpis" },
        h("div", { class: "kpi" }, h("b", {}, "Modo estudio"), h("span", {}, "Revela cada respuesta cuando quieras")),
        h("div", { class: "kpi" }, h("b", {}, "Examen simulado"), h("span", {}, "Con corrección y explicaciones al terminar")),
        h("div", { class: "kpi" }, h("b", {}, "Explicaciones"), h("span", {}, "Entiende por qué la respuesta es correcta"))
      )
    ),
    h("section", { class: "card", style: "max-width:460px" },
      h("h2", { style: "margin-bottom:10px" }, "Mi cuenta"),
      h("div", { class: "tabs", role: "tablist", "aria-label": "Acceso" }, tabLogin, tabSignup),
      form
    )
  );
}

/* Planes */
function viewPlanes() {
  const pend = pendingEnt();
  const activos = activeSlugs();
  const tieneBase = activos.has("piloto-privado");
  const amplia = hasActive();
  const sec = h("section", { class: "stack" });

  sec.append(
    h("div", {},
      h("h1", {}, amplia ? "Ampliar mi cuenta" : "Elige tu plan"),
      h("p", { class: "muted", style: "margin-top:6px" },
        amplia ? "Suma más exámenes a tu cuenta." : "Para empezar, elige el plan que quieres comprar.")
    )
  );
  if (amplia) sec.append(h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "← Volver")));

  if (pend) {
    sec.append(h("div", { class: "msg warn", role: "status" },
      "Elegiste el plan " + pend.plans.name + ". El pago con Mercado Pago aún no está habilitado; " +
      "cuando lo esté podrás completar la compra desde aquí y tu acceso se activará al confirmarse el pago."));
  }

  const grid = h("div", { class: "plans" });
  for (const plan of state.plans) {
    const activo = activos.has(plan.slug);
    const elegido = pend && pend.plans.slug === plan.slug;
    const esAmpliacion = !activo && tieneBase && !!plan.upgrade_from_plan_id;
    const precio = esAmpliacion ? fmtPrice(plan.upgrade_price_amount, plan.currency) : fmtPrice(plan.price_amount, plan.currency);

    let boton;
    if (activo) boton = h("button", { class: "btn block", type: "button", disabled: true }, "Plan activo");
    else if (elegido) boton = h("button", { class: "btn block", type: "button", disabled: true }, "Elegido · pendiente de pago");
    else boton = h("button", { class: "btn block", type: "button", onclick: (ev) => choosePlan(plan.slug, ev.currentTarget) },
      esAmpliacion ? "Ampliar mi cuenta" : "Elegir plan");

    grid.append(h("article", { class: "card item" },
      activo ? h("span", { class: "tag ok" }, "Activo") : null,
      esAmpliacion ? h("span", { class: "tag" }, "Ampliación desde Piloto Privado") : null,
      h("h3", {}, plan.name),
      h("p", { class: "muted grow" }, plan.description || ""),
      h("div", { class: "price" }, precio),
      boton
    ));
  }
  sec.append(grid);
  return sec;
}

async function choosePlan(slug, btn) {
  btn.disabled = true;
  setNotice(null);
  const { error } = await sb.rpc("select_plan", { p_plan_slug: slug });
  if (error) { setNotice("err", errorText(error)); render(); return; }
  await refreshEnts();
  render();
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
          h("button", { class: "btn", type: "button", disabled: vacio, onclick: (ev) => startStudy(ex, ev.currentTarget) }, "Modo estudio"),
          h("button", { class: "btn ghost", type: "button", disabled: vacio, onclick: () => openSimCfg(ex) }, "Examen simulado")
        )
      ));
    }
    sec.append(grid);
  }

  if (!activos.has("paquete-completo")) {
    sec.append(h("div", { class: "card item" },
      h("h3", {}, "Amplía tu cuenta"),
      h("p", { class: "muted" }, "Con el Paquete Completo accedes también a los demás exámenes disponibles."),
      h("div", {}, h("button", { class: "btn ghost", type: "button", onclick: () => go("planes") }, "Ver planes"))
    ));
  }
  return sec;
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
    }
    lista.append(h("button", {
      type: "button", class: cls, "aria-pressed": String(o.id === opts.picked),
      disabled: !!rev, onclick: () => opts.onPick(o.id)
    }, h("span", { class: "lt" }, o.label), h("span", {}, o.text)));
  }
  return h("div", { class: "card" },
    h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(i + 1) },
      h("i", { style: "width:" + Math.round(((i + 1) / total) * 100) + "%" })),
    h("div", { class: "qmeta" }, "Pregunta " + (i + 1) + " de " + total + (q.topic ? " · " + q.topic : "")),
    h("h2", { class: "qtext" }, q.statement),
    lista,
    opts.extra || null
  );
}

/* Modo estudio */
async function startStudy(exam, btn) {
  btn.disabled = true;
  try {
    const qs = await loadQuestions(exam.id);
    if (!qs.length) { btn.disabled = false; setNotice("warn", "Este banco aún no tiene preguntas."); render(); return; }
    state.study = { exam, qs, i: 0, picked: {}, revealed: {} };
    go("estudio");
  } catch (e) {
    btn.disabled = false;
    setNotice("err", "No se pudieron cargar las preguntas."); render();
  }
}

function viewEstudio() {
  const s = state.study;
  const q = s.qs[s.i];
  const rev = s.revealed[q.id];
  const picked = s.picked[q.id];
  const correcta = rev ? q.options.find((o) => o.id === rev.correct) : null;

  let extra = null;
  if (rev) {
    const veredicto = picked ? (picked === rev.correct ? "¡Correcto!" : "Incorrecta.") : "";
    extra = h("div", { class: "explain" },
      h("b", {}, [veredicto, correcta ? "Respuesta correcta: " + correcta.label + ". " + correcta.text : "Respuesta revelada"].filter(Boolean).join(" ")),
      h("p", {}, rev.explanation || "Esta pregunta no tiene explicación todavía.")
    );
  }

  const ultima = s.i === s.qs.length - 1;
  return h("section", { class: "stack" },
    h("div", { class: "row", style: "justify-content:space-between" },
      h("h1", { style: "font-size:clamp(20px,4vw,26px)" }, s.exam.title + " · Estudio"),
      h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "Salir")
    ),
    questionBlock(q, s.i, s.qs.length, {
      picked, revealed: rev, extra,
      onPick: (id) => { s.picked[q.id] = id; render(); }
    }),
    h("div", { class: "row nav" },
      h("button", { class: "btn ghost", type: "button", disabled: s.i === 0, onclick: () => { s.i--; setNotice(null); render(); window.scrollTo(0, 0); } }, "Anterior"),
      h("div", { class: "mid" },
        rev ? null : h("button", { class: "btn", type: "button", onclick: (ev) => revealAnswer(ev.currentTarget) }, "Ver respuesta")
      ),
      ultima
        ? h("button", { class: "btn ghost", type: "button", onclick: () => go("inicio") }, "Terminar")
        : h("button", { class: "btn", type: "button", onclick: () => { s.i++; setNotice(null); render(); window.scrollTo(0, 0); } }, "Siguiente")
    )
  );
}

async function revealAnswer(btn) {
  const s = state.study;
  const q = s.qs[s.i];
  btn.disabled = true;
  setNotice(null);
  const { data, error } = await sb.rpc("reveal_answer", { p_question_id: q.id });
  if (error || !data || !data.length) {
    setNotice("err", error ? errorText(error) : "No se pudo obtener la respuesta.");
    render();
    return;
  }
  s.revealed[q.id] = { correct: data[0].correct_option_id, explanation: data[0].explanation };
  render();
}

/* Examen simulado: configuración */
function openSimCfg(exam) {
  const total = exam.total;
  state.simCfg = { exam, count: Math.min(20, total) };
  go("simcfg");
}

function viewSimCfg() {
  const c = state.simCfg;
  const total = c.exam.total;
  const opciones = [10, 20, 50].filter((n) => n < total).map((n) => ({ n, label: String(n) }));
  opciones.push({ n: total, label: total === 1 ? "1 pregunta" : "Todas (" + total + ")" });

  const seg = h("div", { class: "seg", role: "group", "aria-label": "Cantidad de preguntas" });
  for (const o of opciones) {
    seg.append(h("button", {
      type: "button", "aria-pressed": String(c.count === o.n),
      onclick: () => { c.count = o.n; render(); }
    }, o.label));
  }

  return h("section", { class: "stack" },
    h("div", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => go("inicio") }, "← Volver")),
    h("div", { class: "card stack", style: "max-width:560px" },
      h("h1", { style: "font-size:clamp(22px,4vw,28px)" }, "Examen simulado"),
      h("p", { class: "muted" }, c.exam.title),
      h("div", {}, h("label", {}, "¿Cuántas preguntas quieres responder?"), seg),
      h("p", { class: "hint" }, "Las preguntas se eligen al azar. Verás las respuestas correctas y sus explicaciones al terminar."),
      h("button", { class: "btn", type: "button", onclick: (ev) => startSim(ev.currentTarget) }, "Comenzar examen")
    )
  );
}

async function startSim(btn) {
  const { exam, count } = state.simCfg;
  btn.disabled = true;
  setNotice(null);
  try {
    const { data, error } = await sb.rpc("start_attempt", { p_exam_id: exam.id, p_count: count });
    if (error) throw error;
    const qs = await loadQuestions(exam.id, data.question_ids);
    state.sim = { exam, attemptId: data.attempt_id, qs, i: 0, answers: {}, sent: {}, confirm: false, score: null, review: null };
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
      h("p", { class: "answer" }, h("b", {}, "Tu respuesta: "), elegida ? elegida.label + ". " + elegida.text : "—"),
      h("p", { class: "answer" }, h("b", {}, "Correcta: "), correcta ? correcta.label + ". " + correcta.text : "—"),
      h("div", { class: "explain" },
        h("b", {}, "Explicación"),
        h("p", {}, r.explanation || "Esta pregunta no tiene explicación todavía."))
    ));
  }

  return h("section", { class: "stack" },
    h("div", { class: "score" },
      h("div", { class: "big" }, s.score + "/" + total),
      h("div", {}, h("h2", {}, pct + "% de respuestas correctas"), h("span", {}, s.exam.title))
    ),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", onclick: () => go("inicio") }, "Volver al inicio"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { state.simCfg = { exam: s.exam, count: total }; go("simcfg"); } }, "Repetir examen")
    ),
    items
  );
}

/* ---------- arranque ---------- */

sb.auth.onAuthStateChange((evento, session) => {
  if (evento === "TOKEN_REFRESHED" || evento === "USER_UPDATED" || evento === "PASSWORD_RECOVERY") {
    if (session) state.session = session;
    return;
  }
  const mismoUsuario = session && state.session && state.session.user.id === session.user.id;
  if (mismoUsuario) { state.session = session; return; }
  // Se evita llamar a Supabase dentro del callback para no bloquear el cliente.
  setTimeout(() => loadAccount(session), 0);
});

render();
const { data: { session: inicial } } = await sb.auth.getSession();
if (state.view === "cargando") loadAccount(inicial);
