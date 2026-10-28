// Panel de analítica de Espivota. Enrutado por hash:
//   #/                     resumen global + elecciones en curso
//   #/elections            listado paginado de elecciones con informe
//   #/elections/{id}       informe completo de una elección
"use strict";

const API = "/dashboard/api";
const PAGE_SIZE = 20;
const LIVE_REFRESH_MS = 30_000;
const OPTION_COLORS = ["#0b3ea8", "#2470e3", "#0c1f47", "#6f93d9", "#1b3160", "#9db6e8", "#08307f", "#4f6fa8"];
const BLANK_COLOR = "#a9b4c8";
const INVALID_COLOR = "#b42318";
const ABSTENTION_COLOR = "#e4e9f2";

const ERROR_MESSAGES = {
  election_not_found: "Analytics no ha recibido eventos de esta elección.",
  election_not_closed: "La elección sigue abierta: los resultados se publican cuando cierre y Tally entregue el conteo oficial.",
  tally_pending: "La elección ya cerró, pero el conteo oficial de Tally todavía no ha llegado.",
  storage_unavailable: "La base de datos de resultados no responde. Inténtalo de nuevo en unos minutos.",
};

// --- Utilidades ----------------------------------------------------------------

const numberFormat = new Intl.NumberFormat("es-CO");
const dateTimeFormat = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short" });
const hourFormat = new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false });

const int = (value) => (value === null || value === undefined ? "—" : numberFormat.format(value));
const pct = (value, digits = 1) =>
  value === null || value === undefined
    ? "—"
    : `${(value * 100).toLocaleString("es-CO", { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
const points = (value) =>
  value === null || value === undefined ? "—" : `${value.toLocaleString("es-CO", { maximumFractionDigits: 2 })} pts`;
const dateTime = (iso) => (iso ? dateTimeFormat.format(new Date(iso)) : "—");
const hours = (value) =>
  value === null || value === undefined ? "—" : `${value.toLocaleString("es-CO", { maximumFractionDigits: 1 })} h`;

/** Crea un elemento HTML. Los hijos de texto siempre se insertan como texto. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "style") node.style.cssText = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

class ApiError extends Error {
  constructor(status, code) {
    super(ERROR_MESSAGES[code] ?? "No se pudo cargar la información.");
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = "GET" } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "espivota-analytics" },
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (response.status === 401) {
    window.location.replace("/dashboard/login");
    throw new ApiError(401, "unauthenticated");
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error);
  return body;
}

const optionColor = (result, index) => (result.is_blank ? BLANK_COLOR : OPTION_COLORS[index % OPTION_COLORS.length]);
const electionName = (item) => item.name || item.election_id;

// --- Estructura de la página -----------------------------------------------------

const view = document.getElementById("view");
let refreshTimer = null;
let renderToken = 0;

function setHeader({ eyebrow = "Analítica electoral", title, lead = "", crumbs = [], actions = [] }) {
  document.getElementById("page-eyebrow").textContent = eyebrow;
  document.getElementById("page-title").textContent = title;
  document.getElementById("page-lead").textContent = lead;
  document.title = `${title} · Analítica · Espivota`;
  const nav = document.getElementById("breadcrumbs");
  nav.hidden = crumbs.length === 0;
  nav.querySelector("ol").replaceChildren(
    ...crumbs.map((crumb) =>
      h("li", {}, crumb.href ? h("a", { href: crumb.href }, crumb.label) : h("span", { "aria-current": "page" }, crumb.label)),
    ),
  );
  document.getElementById("page-actions").replaceChildren(...actions);
}

function setActiveNav(name) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function card(title, subtitle, body, extra) {
  return h(
    "section",
    { class: "card" },
    h("header", { class: "card-header" }, h("div", {}, h("h2", {}, title), subtitle ? h("p", {}, subtitle) : null), extra),
    h("div", { class: "card-body" }, body),
  );
}

function kpi(label, value, hint, i = 0) {
  return h(
    "div",
    { class: "kpi reveal", style: `--i: ${i}` },
    h("p", { class: "kpi-label" }, label),
    h("p", { class: "kpi-value" }, value),
    hint ? h("p", { class: "kpi-hint" }, hint) : null,
  );
}

function alertBox(kind, text) {
  return h("div", { class: `alert alert-${kind}`, role: kind === "error" ? "alert" : "status" }, text);
}

function emptyState(title, text) {
  return h("div", { class: "empty" }, h("strong", {}, title), text);
}

function loading() {
  return h(
    "div",
    { class: "stack", "aria-busy": "true" },
    h("div", { class: "kpis" }, ...Array.from({ length: 4 }, () => h("div", { class: "skeleton", style: "height: 6rem" }))),
    h("div", { class: "skeleton", style: "height: 18rem" }),
    h("span", { class: "sr-only" }, "Cargando analítica..."),
  );
}

function statusBadge(status) {
  const map = {
    open: ["badge-success", "En curso", true],
    scheduled: ["badge-muted", "Programada", false],
    closed: ["badge-warning", "Conteo pendiente", false],
    final: ["badge-royal", "Finalizada", false],
    unknown: ["badge-muted", "Sin datos de la elección", false],
  };
  const [cls, text, live] = map[status] ?? map.unknown;
  return h("span", { class: `badge ${cls}` }, h("span", { class: `dot${live ? " pulse" : ""}`, "aria-hidden": "true" }), text);
}

// --- Gráficas reutilizables --------------------------------------------------------

function timelineLabel(iso, bucket, multiDay) {
  const date = new Date(iso);
  if (bucket === "day") return dayFormat.format(date);
  return multiDay ? `${dayFormat.format(date)} ${hourFormat.format(date)}` : hourFormat.format(date);
}

/** Agrupa la serie horaria por día local (la API agrupa por día UTC). */
function dailyLocal(hourly, eligible) {
  const days = [];
  for (const point of hourly) {
    const start = new Date(point.start);
    start.setHours(0, 0, 0, 0);
    const last = days[days.length - 1];
    if (last && last.start === start.toISOString()) {
      last.ballots += point.ballots;
      last.cumulative = point.cumulative;
    } else {
      days.push({ start: start.toISOString(), ballots: point.ballots, cumulative: point.cumulative });
    }
  }
  for (const day of days) day.cumulative_turnout = eligible ? day.cumulative / eligible : null;
  return days;
}

function renderTimeline(container, timeline, bucket, eligible) {
  if (timeline.length === 0) {
    container.replaceChildren(emptyState("Sin papeletas registradas", "Aún no llegan eventos votes.cast de esta elección."));
    return;
  }
  const days = new Set(timeline.map((p) => new Date(p.start).toDateString()));
  const multiDay = days.size > 1;
  const peak = timeline.reduce((best, p, i) => (p.ballots > timeline[best].ballots ? i : best), 0);
  const withTurnout = eligible !== null && eligible !== undefined;
  // Máximo en múltiplos de 20 % para que las cuatro marcas del eje sean redondas.
  const finalTurnout = timeline[timeline.length - 1].cumulative_turnout ?? 0;
  const lineMax = withTurnout ? Math.min(1, Math.max(0.2, Math.ceil(finalTurnout * 5) / 5)) : 1;
  Charts.columns(
    container,
    timeline.map((p) => ({
      label: timelineLabel(p.start, bucket, multiDay),
      value: p.ballots,
      line: withTurnout ? p.cumulative_turnout : null,
      tip:
        `${bucket === "day" ? dayFormat.format(new Date(p.start)) : dateTime(p.start)}\n` +
        `${int(p.ballots)} papeletas · acumulado ${int(p.cumulative)}` +
        (withTurnout ? `\nParticipación acumulada ${pct(p.cumulative_turnout)}` : ""),
    })),
    {
      label: `Papeletas por ${bucket === "day" ? "día" : "hora"}`,
      showLine: withTurnout,
      lineMax,
      lineFormat: (v) => pct(v, 0),
      valueFormat: (v) => int(Math.round(v)),
      highlight: peak,
    },
  );
}

// --- Vista: resumen ----------------------------------------------------------------

async function renderSummary(token) {
  setActiveNav("summary");
  setHeader({
    title: "Resumen",
    lead: "Participación y resultados de todas las elecciones con conteo oficial, y la participación en vivo de las que siguen abiertas.",
  });
  view.replaceChildren(loading());

  const [summary, list, live] = await Promise.all([api("/summary"), api("/elections?limit=100"), api("/live")]);
  if (token !== renderToken) return;

  const liveSection = h("section", { "aria-labelledby": "live-h" });
  const kpis = h(
    "div",
    { class: "kpis" },
    kpi("Elecciones finalizadas", int(summary.elections), "Con conteo oficial de Tally", 1),
    kpi("Papeletas", int(summary.total_ballots), `${int(summary.valid_ballots)} válidas · ${int(summary.invalid_ballots)} nulas`, 2),
    kpi("Participación ponderada", pct(summary.weighted_turnout), `Media simple ${pct(summary.average_turnout)}`, 3),
    kpi("Tasa media de nulos", pct(summary.average_invalid_rate), "Sobre el total de papeletas", 4),
    kpi("Empates", int(summary.ties), "En el primer puesto", 5),
  );

  const content = [kpis, liveSection];

  if (list.items.length === 0) {
    content.push(
      card(
        "Elecciones finalizadas",
        null,
        emptyState("Todavía no hay informes", "Aparecerán aquí cuando Tally publique el conteo oficial de una elección (tally.completed)."),
      ),
    );
  } else {
    const turnoutChart = h("div");
    const marginChart = h("div");
    const withTurnout = list.items.filter((i) => i.turnout !== null);
    const withMargin = list.items.filter((i) => i.margin_points !== null);
    content.push(
      h(
        "div",
        { class: "grid-2" },
        card(
          "Participación por elección",
          "Papeletas sobre el censo habilitado.",
          withTurnout.length ? turnoutChart : emptyState("Sin censo", "Ninguna elección tiene el evento census.updated."),
        ),
        card(
          "Margen de victoria",
          "Diferencia entre el primer y el segundo lugar, en puntos de los votos válidos.",
          withMargin.length ? marginChart : emptyState("Sin márgenes", "Se necesitan al menos dos opciones con votos."),
        ),
      ),
      highlights(summary, list.items),
      electionsTable(list.items.slice(0, 8), "Elecciones recientes", h("a", { class: "btn btn-ghost btn-sm", href: "#/elections" }, "Ver todas")),
    );
    view.replaceChildren(h("div", { class: "stack" }, ...content));
    Charts.barsH(
      turnoutChart,
      withTurnout.map((i) => ({
        label: electionName(i),
        value: i.turnout,
        valueText: pct(i.turnout),
        tip: `${electionName(i)}\nParticipación ${pct(i.turnout)} · ${int(i.total_ballots)} papeletas`,
      })),
      { label: "Participación por elección", max: 1 },
    );
    const maxMargin = Math.max(5, ...withMargin.map((i) => i.margin_points));
    Charts.barsH(
      marginChart,
      withMargin
        .slice()
        .sort((a, b) => a.margin_points - b.margin_points)
        .map((i) => ({
          label: electionName(i),
          value: i.margin_points,
          valueText: points(i.margin_points),
          color: i.tie ? "#8a5a00" : "#0c1f47",
          note: i.tie ? "Empate" : i.winner ? `Gana ${i.winner}` : "",
          tip: `${electionName(i)}\n${i.tie ? "Empate en el primer puesto" : `Gana ${i.winner}`}\nMargen ${points(i.margin_points)}`,
        })),
      { label: "Margen de victoria por elección", max: maxMargin },
    );
  }
  if (list.items.length === 0) view.replaceChildren(h("div", { class: "stack" }, ...content));

  renderLive(liveSection, live);
  refreshTimer = setInterval(async () => {
    try {
      const fresh = await api("/live");
      if (token === renderToken) renderLive(liveSection, fresh);
    } catch {
      /* se reintenta en el siguiente ciclo */
    }
  }, LIVE_REFRESH_MS);
}

function renderLive(section, items) {
  const header = h(
    "div",
    { class: "card-header", style: "border: 0; padding: 0 0 1rem" },
    h(
      "div",
      {},
      h("h2", { id: "live-h", style: "font-size: 1.125rem; font-weight: 700" }, "Participación en vivo"),
      h("p", {}, "Elecciones sin conteo oficial. Se actualiza cada 30 segundos; la hora en curso se publica al terminar."),
    ),
  );
  if (items.length === 0) {
    section.replaceChildren(header, h("div", { class: "card" }, emptyState("No hay elecciones en curso", "Todas las elecciones conocidas ya tienen conteo oficial.")));
    return;
  }
  section.replaceChildren(
    header,
    h(
      "div",
      { class: "live-grid" },
      ...items.map((item, index) => {
        const spark = h("div", { style: "margin-top: 0.75rem" });
        const node = h(
          "article",
          { class: "card live-card reveal", style: `--i: ${index}` },
          statusBadge(item.status),
          h("h3", {}, electionName(item)),
          h("p", { class: "count" }, int(item.ballots_received), h("span", { class: "small muted", style: "font-weight: 500" }, " papeletas")),
          item.turnout !== null
            ? h(
                "div",
                { style: "margin-top: 0.5rem" },
                h("div", { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(item.turnout * 100)), "aria-label": "Participación" }, h("span", { style: `width: ${Math.min(100, item.turnout * 100)}%` })),
                h("p", { class: "xs muted", style: "margin-top: 0.375rem" }, `Participación ${pct(item.turnout)} de ${int(item.eligible_voters)} habilitados`),
              )
            : h("p", { class: "xs muted", style: "margin-top: 0.5rem" }, "Censo no disponible"),
          spark,
          h("p", { class: "xs subtle", style: "margin-top: 0.5rem" }, item.closes_at ? `Cierra ${dateTime(item.closes_at)}` : "Sin fecha de cierre"),
        );
        Charts.sparkline(spark, item.timeline.map((p) => p.ballots), { label: `Papeletas por hora de ${electionName(item)}` });
        return node;
      }),
    ),
  );
}

function highlights(summary, items) {
  const nameOf = (metric) => {
    if (!metric) return "—";
    const found = items.find((i) => i.election_id === metric.election_id);
    return found ? electionName(found) : metric.election_id;
  };
  const link = (metric, text) =>
    metric ? h("a", { class: "link", href: `#/elections/${encodeURIComponent(metric.election_id)}` }, text) : "—";
  return card(
    "Destacados",
    "Comparación entre todas las elecciones finalizadas.",
    h(
      "dl",
      { class: "facts" },
      h("div", {}, h("dt", {}, "Mayor participación"), h("dd", {}, link(summary.highest_turnout, `${nameOf(summary.highest_turnout)} · ${pct(summary.highest_turnout?.value)}`))),
      h("div", {}, h("dt", {}, "Menor participación"), h("dd", {}, link(summary.lowest_turnout, `${nameOf(summary.lowest_turnout)} · ${pct(summary.lowest_turnout?.value)}`))),
      h("div", {}, h("dt", {}, "Elección más reñida"), h("dd", {}, link(summary.closest_race, `${nameOf(summary.closest_race)} · ${points(summary.closest_race?.value)}`))),
      h("div", {}, h("dt", {}, "Elección más grande"), h("dd", {}, link(summary.largest_election, `${nameOf(summary.largest_election)} · ${int(summary.largest_election?.value)} papeletas`))),
      h("div", {}, h("dt", {}, "Censo acumulado"), h("dd", {}, `${int(summary.eligible_voters)} habilitados`)),
    ),
  );
}

function electionsTable(items, title, extra, pager) {
  const body = h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data-table" },
      h(
        "thead",
        {},
        h("tr", {}, h("th", { scope: "col" }, "Elección"), h("th", { scope: "col" }, "Cierre"), h("th", { scope: "col", class: "num" }, "Papeletas"), h("th", { scope: "col", class: "num" }, "Participación"), h("th", { scope: "col" }, "Resultado"), h("th", { scope: "col", class: "num" }, "Margen")),
      ),
      h(
        "tbody",
        {},
        ...items.map((item) =>
          h(
            "tr",
            {},
            h("td", {}, h("a", { href: `#/elections/${encodeURIComponent(item.election_id)}` }, electionName(item)), item.name ? h("div", { class: "xs subtle mono" }, item.election_id) : null),
            h("td", { class: "small muted" }, dateTime(item.closed_at)),
            h("td", { class: "num" }, int(item.total_ballots)),
            h("td", { class: "num" }, pct(item.turnout)),
            h("td", {}, item.tie ? h("span", { class: "badge badge-warning" }, "Empate") : item.winner ? h("span", { class: "badge badge-royal" }, item.winner) : h("span", { class: "subtle" }, "Sin votos válidos")),
            h("td", { class: "num" }, points(item.margin_points)),
          ),
        ),
      ),
    ),
  );
  const section = card(title, null, body, extra);
  section.querySelector(".card-body").style.padding = "0";
  if (pager) section.append(pager);
  return section;
}

// --- Vista: listado ----------------------------------------------------------------

async function renderList(token, page) {
  setActiveNav("elections");
  setHeader({
    title: "Elecciones",
    lead: "Elecciones con conteo oficial, de la más reciente a la más antigua.",
    crumbs: [{ href: "#/", label: "Resumen" }, { label: "Elecciones" }],
  });
  view.replaceChildren(loading());
  const offset = (page - 1) * PAGE_SIZE;
  const list = await api(`/elections?limit=${PAGE_SIZE}&offset=${offset}`);
  if (token !== renderToken) return;
  if (list.total === 0) {
    view.replaceChildren(h("div", { class: "card" }, emptyState("Todavía no hay informes", "Aparecerán cuando Tally publique el conteo oficial de una elección.")));
    return;
  }
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const pager = h(
    "nav",
    { class: "pager", "aria-label": "Paginación" },
    h("span", {}, `Página ${page} de ${pages} · ${int(list.total)} elecciones`),
    h(
      "span",
      { style: "display: flex; gap: 0.5rem" },
      page > 1 ? h("a", { class: "btn btn-secondary btn-sm", href: `#/elections?page=${page - 1}` }, "Anterior") : null,
      page < pages ? h("a", { class: "btn btn-secondary btn-sm", href: `#/elections?page=${page + 1}` }, "Siguiente") : null,
    ),
  );
  view.replaceChildren(electionsTable(list.items, "Elecciones finalizadas", null, pager));
}

// --- Vista: detalle ------------------------------------------------------------------

async function renderElection(token, electionId) {
  setActiveNav("elections");
  const crumbs = [{ href: "#/", label: "Resumen" }, { href: "#/elections", label: "Elecciones" }];
  setHeader({ title: electionId, eyebrow: "Informe de elección", crumbs: [...crumbs, { label: electionId }] });
  view.replaceChildren(loading());

  let report;
  try {
    report = await api(`/elections/${encodeURIComponent(electionId)}`);
  } catch (error) {
    if (token !== renderToken) return;
    if (error.code === "election_not_closed" || error.code === "tally_pending") {
      const live = await api(`/elections/${encodeURIComponent(electionId)}/participation`);
      if (token !== renderToken) return;
      return renderPending(live, error, crumbs);
    }
    throw error;
  }
  if (token !== renderToken) return;

  const name = electionName(report);
  const recompute = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Recalcular informe");
  const print = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => window.print() }, "Imprimir");
  setHeader({
    eyebrow: "Informe final",
    title: name,
    lead: `Cerrada ${dateTime(report.schedule.closed_at)} · Conteo oficial recibido ${dateTime(report.tallied_at)}`,
    crumbs: [...crumbs, { label: name }],
    actions: [print, recompute],
  });

  const notice = h("div");
  recompute.addEventListener("click", async () => {
    recompute.disabled = true;
    recompute.textContent = "Recalculando...";
    try {
      await api(`/elections/${encodeURIComponent(electionId)}/recompute`, { method: "POST" });
      await route();
      document.getElementById("view").prepend(alertBox("success", "Informe recalculado con los datos más recientes."));
    } catch (error) {
      notice.replaceChildren(alertBox("error", error.message));
      recompute.disabled = false;
      recompute.textContent = "Recalcular informe";
    }
  });

  const { totals, rates, outcome, competitiveness, participation, schedule } = report;
  const resultsChart = h("div");
  const compositionChart = h("div");
  const compositionLegend = h("ul", { class: "donut-legend" });
  const timelineChart = h("div");
  const hourChart = h("div");
  const bucketToggle = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "Agrupar por" },
    h("button", { type: "button", "aria-pressed": "true", dataset: { bucket: "hour" } }, "Por hora"),
    h("button", { type: "button", "aria-pressed": "false", dataset: { bucket: "day" } }, "Por día"),
  );

  const warnings = [];
  if (outcome.blank_won) warnings.push(alertBox("warning", "El voto en blanco obtuvo la mayoría de los votos válidos."));
  if (!participation.matches_tally)
    warnings.push(
      alertBox(
        "info",
        `Analytics registró ${int(participation.recorded_ballots)} eventos votes.cast y el conteo oficial tiene ${int(totals.total_ballots)} papeletas. Los resultados usan el conteo oficial; la línea de tiempo puede estar incompleta.`,
      ),
    );
  if (totals.eligible_voters === null) warnings.push(alertBox("info", "No llegó el tamaño del censo (census.updated): participación y abstención no se pueden calcular."));

  view.replaceChildren(
    h(
      "div",
      { class: "stack" },
      notice,
      ...warnings,
      outcomeCard(report),
      h(
        "div",
        { class: "kpis" },
        kpi("Censo habilitado", int(totals.eligible_voters), totals.abstentions !== null ? `${int(totals.abstentions)} no votaron` : "Sin dato de censo", 1),
        kpi("Papeletas", int(totals.total_ballots), `Duración ${hours(schedule.duration_hours)}`, 2),
        kpi("Participación", pct(rates.turnout), `Abstención ${pct(rates.abstention)}`, 3),
        kpi("Votos válidos", int(totals.valid_ballots), pct(rates.valid), 4),
        kpi("Votos nulos", int(totals.invalid_ballots), pct(rates.invalid), 5),
        kpi("Votos en blanco", int(totals.blank_ballots), totals.blank_ballots === null ? "Sin opción en blanco" : `${pct(rates.blank)} de los válidos`, 6),
      ),
      h(
        "div",
        { class: "grid-2 grid-main-aside" },
        card("Resultados por opción", "Votos de cada opción y su porcentaje sobre los votos válidos.", resultsChart),
        card("Composición", totals.eligible_voters !== null ? "Distribución del censo habilitado." : "Distribución de las papeletas.", h("div", { class: "donut-layout" }, compositionChart, compositionLegend)),
      ),
      resultsTable(report),
      card("Participación en el tiempo", "Papeletas recibidas y participación acumulada (línea). La barra más clara es el pico.", timelineChart, bucketToggle),
      h(
        "div",
        { class: "grid-2" },
        card("Distribución por hora del día", `Papeletas según la hora local (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`, hourChart),
        card("Competitividad y calidad del dato", null, factsCard(report)),
      ),
    ),
  );

  Charts.barsH(
    resultsChart,
    report.results.map((r, i) => ({
      label: `${r.rank}. ${r.option}`,
      value: r.votes,
      valueText: `${int(r.votes)} · ${pct(r.share_of_valid)}`,
      color: optionColor(r, i),
      tip: `${r.option}${r.is_blank ? " (voto en blanco)" : ""}\n${int(r.votes)} votos\n${pct(r.share_of_valid)} de los válidos · ${pct(r.share_of_total)} del total`,
    })),
    { label: "Votos por opción" },
  );

  const segments = [
    { label: "Votos por candidaturas", value: totals.valid_ballots - (totals.blank_ballots ?? 0), color: "#0b3ea8" },
    ...(totals.blank_ballots !== null ? [{ label: "Votos en blanco", value: totals.blank_ballots, color: BLANK_COLOR }] : []),
    { label: "Votos nulos", value: totals.invalid_ballots, color: INVALID_COLOR },
    ...(totals.abstentions !== null ? [{ label: "Abstención", value: totals.abstentions, color: ABSTENTION_COLOR }] : []),
  ];
  const base = totals.eligible_voters ?? totals.total_ballots;
  for (const s of segments) s.tip = `${s.label}\n${int(s.value)} · ${pct(base ? s.value / base : 0)}`;
  Charts.donut(compositionChart, segments, {
    centerValue: totals.eligible_voters !== null ? pct(rates.turnout, 0) : int(totals.total_ballots),
    centerLabel: totals.eligible_voters !== null ? "participación" : "papeletas",
    label: "Composición del censo y las papeletas",
  });
  compositionLegend.replaceChildren(
    ...segments.map((s) =>
      h("li", {}, h("span", {}, h("span", { class: "swatch", style: `background: ${s.color}; box-shadow: inset 0 0 0 1px rgb(11 23 48 / 0.12)` }), s.label), h("strong", {}, `${int(s.value)} · ${pct(base ? s.value / base : 0)}`)),
    ),
  );

  renderTimeline(timelineChart, participation.timeline, "hour", totals.eligible_voters);
  bucketToggle.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-bucket]");
    if (!button || button.getAttribute("aria-pressed") === "true") return;
    bucketToggle.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    const bucket = button.dataset.bucket;
    const series = bucket === "day" ? dailyLocal(participation.timeline, totals.eligible_voters) : participation.timeline;
    renderTimeline(timelineChart, series, bucket, totals.eligible_voters);
  });

  const byHour = Array.from({ length: 24 }, () => 0);
  for (const p of participation.timeline) byHour[new Date(p.start).getHours()] += p.ballots;
  const busiest = byHour.indexOf(Math.max(...byHour));
  Charts.columns(
    hourChart,
    byHour.map((value, hour) => ({
      label: String(hour).padStart(2, "0"),
      value,
      tip: `${String(hour).padStart(2, "0")}:00 – ${String(hour).padStart(2, "0")}:59\n${int(value)} papeletas`,
    })),
    { label: "Papeletas por hora del día", valueFormat: (v) => int(Math.round(v)), highlight: participation.timeline.length ? busiest : -1, color: "#1b3160" },
  );
}

function outcomeCard(report) {
  const { outcome, results } = report;
  const winner = results.find((r) => r.option === outcome.winner);
  const runner = results.find((r) => r.option === outcome.runner_up);
  const trophy = h("span", { class: `medal${outcome.tie ? " tie" : ""}`, "aria-hidden": "true" });
  trophy.innerHTML = outcome.tie
    ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 9h14M5 15h14"/></svg>'
    : '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>';

  let main;
  if (outcome.tie) {
    main = h("div", {}, h("p", { class: "eyebrow" }, "Empate en el primer puesto"), h("p", { class: "outcome-name" }, outcome.tied_options.join(" · ")), h("p", { class: "small muted" }, `${int(results[0].votes)} votos cada una`));
  } else if (winner) {
    main = h("div", {}, h("p", { class: "eyebrow" }, outcome.blank_won ? "Opción con más votos (en blanco)" : "Opción ganadora"), h("p", { class: "outcome-name" }, winner.option), h("p", { class: "small muted" }, `${int(winner.votes)} votos · ${pct(winner.share_of_valid)} de los válidos`));
  } else {
    main = h("div", {}, h("p", { class: "eyebrow" }, "Sin ganador"), h("p", { class: "outcome-name" }, "No hubo votos válidos"));
  }

  return h(
    "section",
    { class: "card outcome reveal", "aria-label": "Resultado de la elección" },
    h("div", { class: "outcome-main" }, trophy, main),
    h("div", { class: "outcome-stat" }, h("span", { class: "small muted" }, "Segundo lugar"), h("strong", {}, runner ? runner.option : "—"), h("span", { class: "xs subtle" }, runner ? `${int(runner.votes)} votos · ${pct(runner.share_of_valid)}` : "")),
    h("div", { class: "outcome-stat" }, h("span", { class: "small muted" }, "Margen"), h("strong", {}, outcome.margin_votes !== null ? `${int(outcome.margin_votes)} votos` : "—"), h("span", { class: "xs subtle" }, points(outcome.margin_points))),
  );
}

function resultsTable(report) {
  const table = h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data-table" },
      h("caption", { class: "sr-only" }, "Resultados por opción"),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Puesto"), h("th", { scope: "col" }, "Opción"), h("th", { scope: "col", class: "num" }, "Votos"), h("th", { scope: "col", class: "num" }, "% válidos"), h("th", { scope: "col", class: "num" }, "% total"), h("th", { scope: "col", style: "width: 28%" }, "Proporción"))),
      h(
        "tbody",
        {},
        ...report.results.map((r, i) =>
          h(
            "tr",
            {},
            h("td", { class: "num", style: "text-align: left" }, `${r.rank}.`),
            h("td", {}, h("span", { class: "swatch", style: `background: ${optionColor(r, i)}` }), r.option, r.is_blank ? h("span", { class: "badge badge-muted", style: "margin-left: 0.5rem" }, "En blanco") : null, r.option === report.outcome.winner ? h("span", { class: "badge badge-royal", style: "margin-left: 0.5rem" }, "Ganadora") : null),
            h("td", { class: "num" }, int(r.votes)),
            h("td", { class: "num" }, pct(r.share_of_valid)),
            h("td", { class: "num" }, pct(r.share_of_total)),
            h("td", {}, h("div", { class: "meter" }, h("span", { style: `width: ${r.share_of_valid * 100}%; background: ${optionColor(r, i)}` }))),
          ),
        ),
        h(
          "tr",
          {},
          h("td", {}),
          h("td", { class: "muted" }, "Votos nulos"),
          h("td", { class: "num" }, int(report.totals.invalid_ballots)),
          h("td", { class: "num subtle" }, "—"),
          h("td", { class: "num" }, pct(report.rates.invalid)),
          h("td", {}, h("div", { class: "meter" }, h("span", { style: `width: ${report.rates.invalid * 100}%; background: ${INVALID_COLOR}` }))),
        ),
      ),
    ),
  );
  const section = card("Tabla de resultados", "Puestos con ranking de competición: las opciones empatadas comparten puesto.", table);
  section.querySelector(".card-body").style.padding = "0";
  return section;
}

function factsCard(report) {
  const { competitiveness: c, participation: p, schedule: s } = report;
  return h(
    "dl",
    { class: "facts" },
    h("div", {}, h("dt", {}, "Opciones con votos"), h("dd", {}, `${int(c.options_with_votes)} de ${int(report.results.length)}`)),
    h("div", {}, h("dt", { title: "1 / Σ (proporción de los válidos)²" }, "Número efectivo de opciones"), h("dd", {}, c.effective_number_of_options === null ? "—" : c.effective_number_of_options.toLocaleString("es-CO", { maximumFractionDigits: 2 }))),
    h("div", {}, h("dt", { title: "Σ (proporción de los válidos)²; 1 = una sola opción concentra todo" }, "Índice de concentración (HHI)"), h("dd", {}, c.herfindahl_index === null ? "—" : c.herfindahl_index.toLocaleString("es-CO", { maximumFractionDigits: 4 }))),
    h("div", {}, h("dt", {}, "Hora pico"), h("dd", {}, p.peak ? `${dateTime(p.peak.start)} · ${int(p.peak.ballots)}` : "—")),
    h("div", {}, h("dt", {}, "Primera / última papeleta"), h("dd", {}, p.first_ballot_at ? `${hourFormat.format(new Date(p.first_ballot_at))} – ${hourFormat.format(new Date(p.last_ballot_at))}` : "—")),
    h("div", {}, h("dt", {}, "Eventos votes.cast vs. conteo"), h("dd", {}, h("span", { class: `badge ${p.matches_tally ? "badge-success" : "badge-warning"}` }, p.matches_tally ? "Coinciden" : `${int(p.recorded_ballots)} / ${int(report.totals.total_ballots)}`))),
    h("div", {}, h("dt", {}, "Apertura"), h("dd", {}, dateTime(s.opens_at))),
    h("div", {}, h("dt", {}, "Cierre programado"), h("dd", {}, dateTime(s.closes_at))),
    h("div", {}, h("dt", {}, "Informe generado"), h("dd", {}, dateTime(report.generated_at))),
  );
}

function renderPending(live, error, crumbs) {
  const name = electionName(live);
  setHeader({
    eyebrow: "Participación en vivo",
    title: name,
    lead: live.closes_at ? `Abre ${dateTime(live.opens_at)} · Cierra ${dateTime(live.closes_at)}` : "",
    crumbs: [...crumbs, { label: name }],
  });
  const timeline = h("div");
  view.replaceChildren(
    h(
      "div",
      { class: "stack" },
      alertBox("info", error.message),
      h(
        "div",
        { class: "kpis" },
        h("div", { class: "kpi" }, h("p", { class: "kpi-label" }, "Estado"), h("p", { class: "kpi-value", style: "font-size: 1rem; margin-top: 0.75rem" }, statusBadge(live.status))),
        kpi("Papeletas recibidas", int(live.ballots_received), `Actualizado ${hourFormat.format(new Date(live.as_of))}`, 1),
        kpi("Participación", pct(live.turnout), live.eligible_voters !== null ? `de ${int(live.eligible_voters)} habilitados` : "Sin dato de censo", 2),
      ),
      card("Participación por hora", "Solo horas completas mientras la urna está abierta, para no revelar el ritmo voto a voto.", timeline),
    ),
  );
  renderTimeline(timeline, live.timeline, "hour", live.eligible_voters);
}

// --- Enrutado ------------------------------------------------------------------------

async function route() {
  const token = ++renderToken;
  clearInterval(refreshTimer);
  const [path, query = ""] = window.location.hash.replace(/^#/, "").split("?");
  const segments = path.split("/").filter(Boolean);
  try {
    if (segments.length === 0) await renderSummary(token);
    else if (segments[0] === "elections" && segments.length === 1) {
      const page = Math.max(1, Number.parseInt(new URLSearchParams(query).get("page") ?? "1", 10) || 1);
      await renderList(token, page);
    } else if (segments[0] === "elections" && segments.length === 2) await renderElection(token, decodeURIComponent(segments[1]));
    else {
      setHeader({ title: "Página no encontrada", crumbs: [{ href: "#/", label: "Resumen" }, { label: "No encontrada" }] });
      view.replaceChildren(h("div", { class: "card" }, emptyState("Esta página no existe", h("a", { class: "link", href: "#/" }, "Volver al resumen"))));
    }
  } catch (error) {
    if (token !== renderToken || error.status === 401) return;
    const message = error.code === "network" ? "No se pudo contactar el servicio de analítica." : error.message;
    view.replaceChildren(
      h("div", { class: "stack" }, alertBox("error", message), error.status === 404 ? h("a", { class: "btn btn-secondary", href: "#/" }, "Volver al resumen") : null),
    );
  }
}

async function loadUser() {
  try {
    const { user } = await api("/me");
    document.getElementById("user-name").textContent = user.name;
    document.getElementById("user-initials").textContent = user.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("");
    document.getElementById("user-chip").title = user.email;
    document.getElementById("user-chip").hidden = false;
  } catch {
    /* api() ya redirige al login si la sesión expiró */
  }
}

document.getElementById("logout").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await api("/logout", { method: "POST" });
  } finally {
    window.location.replace("/dashboard/login");
  }
});

document.querySelectorAll("[data-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

window.addEventListener("hashchange", () => {
  route();
  document.getElementById("main-content").focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
});
loadUser();
route();
