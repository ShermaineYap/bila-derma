import { T, LANGS, LOCALES, fill } from "./i18n.js";
import { parseDate, isoDate, nextEligible, pickWeek, describePct, buildIcs, pastVsUsual, range } from "./logic.js";

const TYPES = ["all", "o", "a", "b", "ab"];
const PAST_WEEKS = 12;
const STORE_KEY = "bila-derma";
const $ = (id) => document.getElementById(id);

const state = { lang: "ms", type: "all", area: "Malaysia", last: "", interval: 3, data: null, pick: null };

// ------------------------------------------------------------------ storage (best effort)
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    Object.assign(state, pickKeys(saved, ["lang", "type", "area", "last", "interval"]));
  } catch { /* storage unavailable */ }
  if (!localStorage.getItem?.(STORE_KEY)) {
    const nav = (navigator.language || "").toLowerCase();
    state.lang = nav.startsWith("zh") ? "zh" : nav.startsWith("ta") ? "ta" : nav.startsWith("en") ? "en" : "ms";
  }
}
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pickKeys(state, ["lang", "type", "area", "last", "interval"])));
  } catch { /* storage unavailable */ }
}
function pickKeys(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

// ------------------------------------------------------------------ formatting
const t = () => T[state.lang];
const loc = () => LOCALES[state.lang];
const areaName = (a) => t().areas[a] || a;
const typeName = (ty) => (ty === "all" ? t().type_all : ty.toUpperCase());
const num = (n) => new Intl.NumberFormat(loc(), { maximumFractionDigits: 0 }).format(n);

function fmtRange(start, end, withYear = false) {
  const opts = { day: "numeric", month: "short" };
  if (withYear) opts.year = "numeric";
  const f = new Intl.DateTimeFormat(loc(), opts);
  const s = parseDate(start), e = parseDate(end);
  return f.formatRange ? f.formatRange(s, e) : `${f.format(s)} – ${f.format(e)}`;
}
function fmtDate(iso, opts = { day: "numeric", month: "long", year: "numeric" }) {
  return new Intl.DateTimeFormat(loc(), opts).format(parseDate(iso));
}
function pctWords(pct) {
  const d = describePct(pct);
  if (d.key === "below_usual") return fill(t().pct_below, { n: d.value });
  if (d.key === "above_usual") return fill(t().pct_above, { n: d.value });
  return t().pct_about;
}
const festSuffix = (key) => (key ? fill(t().paren, { x: t().fest[key] }) : "");

// ------------------------------------------------------------------ static text + controls
function applyText() {
  document.documentElement.lang = state.lang;
  document.title = t().doc_title;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = t()[el.dataset.i18n];
    if (typeof v === "string") el.textContent = v;
  });
  const langs = document.querySelector(".langs");
  langs.querySelectorAll("button").forEach((b) => b.remove());
  for (const [code, label] of Object.entries(LANGS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.lang = code;
    b.setAttribute("aria-pressed", String(code === state.lang));
    b.addEventListener("click", () => { state.lang = code; savePrefs(); renderAll(); });
    langs.appendChild(b);
  }
  // Blood group pills
  const types = $("types");
  types.innerHTML = "";
  for (const ty of TYPES) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="radio" name="type" value="${ty}"><span></span>`;
    l.querySelector("span").textContent = typeName(ty);
    const input = l.querySelector("input");
    input.checked = ty === state.type;
    input.addEventListener("change", () => { state.type = ty; savePrefs(); renderResults(); });
    types.appendChild(l);
  }
  // Areas
  const areaSel = $("area");
  const areas = Object.keys(state.data.forecast.series);
  const ordered = ["Malaysia", ...areas.filter((a) => a !== "Malaysia").sort()];
  areaSel.innerHTML = "";
  for (const a of ordered) {
    const o = document.createElement("option");
    o.value = a; o.textContent = areaName(a);
    areaSel.appendChild(o);
  }
  if (!ordered.includes(state.area)) state.area = "Malaysia";
  areaSel.value = state.area;
  // Interval
  const iv = $("interval");
  iv.innerHTML = "";
  for (const n of [3, 4]) {
    const o = document.createElement("option");
    o.value = n; o.textContent = fill(t().months, { n });
    iv.appendChild(o);
  }
  iv.value = String(state.interval);
  const last = $("last");
  last.value = state.last || "";
  last.max = isoDate(new Date());
  // Static lists
  const lim = $("limits");
  lim.innerHTML = "";
  for (const s of t().limits) { const li = document.createElement("li"); li.textContent = s; lim.appendChild(li); }
}

function bindForm() {
  $("area").addEventListener("change", (e) => { state.area = e.target.value; savePrefs(); renderResults(); });
  $("interval").addEventListener("change", (e) => { state.interval = Number(e.target.value); savePrefs(); renderResults(); });
  $("last").addEventListener("change", (e) => { state.last = e.target.value; savePrefs(); renderResults(); });
  $("form").addEventListener("submit", (e) => e.preventDefault());
  $("btn-ics").addEventListener("click", downloadIcs);
  $("btn-share").addEventListener("click", share);
}

// ------------------------------------------------------------------ series selection
function currentSeries() {
  const s = state.data.forecast.series;
  return s[state.area]?.[state.type] || s[state.area]?.all || s.Malaysia.all;
}
function currentHistory() {
  const h = state.data.history.series;
  return h[state.area]?.[state.type] || h[state.area]?.all || h.Malaysia.all;
}

// ------------------------------------------------------------------ answer
function renderAnswer() {
  const { weeks } = state.data.forecast;
  const series = currentSeries();
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const eligible = nextEligible(parseDate(state.last), state.interval, today);
  const pick = pickWeek(weeks, series.forecast, eligible);
  state.pick = pick;
  const actions = $("actions");
  const area = areaName(state.area);
  if (pick.status !== "ok") {
    $("answer-h").textContent = "";
    $("answer-why").textContent = pick.status === "beyond_forecast" ? fill(t().beyond, { date: fmtDate(pick.eligible) }) : t().load_error;
    $("answer-hol").textContent = "";
    actions.hidden = true;
    return;
  }
  actions.hidden = false;
  const w = weeks[pick.index], dip = weeks[pick.dipIndex];
  const fc = series.forecast;
  $("answer-h").textContent = fill(t().result_heading, { range: fmtRange(w.week_start, w.week_end, true) });
  let why;
  if (pick.reason === "before_holiday") {
    why = fill(t().reason_before_holiday, { area, pct: pctWords(fc[pick.dipIndex].vs_usual_pct),
      dip: fmtRange(dip.week_start, dip.week_end), fest: festSuffix(dip.festive) });
  } else if (pick.reason === "no_dip") {
    why = fill(t().reason_no_dip, { pct: pctWords(fc[pick.index].vs_usual_pct) });
  } else {
    why = fill(t().reason_lowest, { area, pct: pctWords(fc[pick.index].vs_usual_pct), fest: festSuffix(w.festive) });
  }
  $("answer-why").textContent = why;
  const hol = (w.holidays || []).map((h) => `${h.name} (${fmtDate(h.date, { day: "numeric", month: "short" })})`);
  $("answer-hol").textContent = hol.length ? fill(t().holidays_note, { list: hol.join(", ") }) : "";
}

function shareMessage() {
  const { weeks } = state.data.forecast;
  const p = state.pick;
  const w = weeks[p.index];
  const dipIdx = p.reason === "before_holiday" ? p.dipIndex : p.index;
  return fill(t().share_text, {
    area: areaName(state.area),
    pct: pctWords(currentSeries().forecast[dipIdx].vs_usual_pct),
    fest: festSuffix(weeks[dipIdx].festive),
    range: fmtRange(w.week_start, w.week_end, true),
    url: pageUrl(),
  });
}
function pageUrl() { return location.href.split(/[?#]/)[0]; }

function downloadIcs() {
  if (state.pick?.status !== "ok") return;
  const w = state.data.forecast.weeks[state.pick.index];
  const ics = buildIcs({ weekStart: w.week_start, weekEnd: w.week_end, title: t().ics_title,
    description: `${$("answer-why").textContent}\n${fill(t().ics_desc, { url: pageUrl() })}` });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `bila-derma-${w.week_start}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function share() {
  if (state.pick?.status !== "ok") return;
  const text = shareMessage();
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  try {
    await navigator.clipboard.writeText(text);
    toast(t().copied);
  } catch {
    window.prompt(t().share, text);
  }
}
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  clearTimeout(toast.tid);
  toast.tid = setTimeout(() => { el.textContent = ""; }, 2500);
}

// ------------------------------------------------------------------ chart
const SVG_NS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderChart(animate) {
  const svg = $("chart");
  svg.innerHTML = "";
  const { weeks } = state.data.forecast;
  const series = currentSeries();
  const hist = state.data.history;
  const counts = currentHistory();
  const W = Math.max(320, Math.round(svg.clientWidth || svg.parentElement.clientWidth || 640));
  const nPast = W < 520 ? 6 : PAST_WEEKS;
  const pastPct = pastVsUsual(counts).slice(-nPast);
  const pastWeeks = hist.weeks.slice(-nPast);
  const pastCounts = counts.slice(-nPast);
  const items = [
    ...pastWeeks.map((we, i) => {
      const start = isoDate(new Date(parseDate(we).getTime() - 6 * 864e5));
      return { past: true, start, end: we, pct: pastPct[i], n: pastCounts[i], festive: hist.festive.slice(-nPast)[i] };
    }),
    ...weeks.map((w, i) => {
      const f = series.forecast[i];
      const usual = series.level;
      return { past: false, start: w.week_start, end: w.week_end, pct: f.vs_usual_pct, festive: w.festive,
        lo: f.lo, hi: f.hi, loPct: (f.lo / usual - 1) * 100, hiPct: (f.hi / usual - 1) * 100, idx: i };
    }),
  ];
  const H = W < 520 ? 260 : 300, top = 34, bottom = 50, left = 4, right = 4;
  const plotH = H - top - bottom;
  const extent = Math.min(60, Math.max(20, ...items.map((d) => Math.abs(d.pct ?? 0))) * 1.25);
  const y0 = top + plotH / 2;
  const yScale = (pct) => y0 - (Math.max(-extent, Math.min(extent, pct)) / extent) * (plotH / 2);
  const step = (W - left - right) / items.length;
  const bw = Math.max(6, step * 0.7);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const desc = [];

  // Usual line
  svg.appendChild(el("line", { x1: left, x2: W - right, y1: y0, y2: y0, class: "axis-usual" }));
  // Today line
  const xToday = left + nPast * step;
  svg.appendChild(el("line", { x1: xToday, x2: xToday, y1: top - 10, y2: H - bottom + 4, class: "axis-today" }));
  svg.appendChild(el("text", { x: xToday + 4, y: top - 14, class: "lbl" }, t().today));

  let lastMonth = null, lastFest = null;
  const rowEnd = [-1e9, -1e9];
  // Place a label centred on cx but kept inside the chart; returns [x, anchor, left, right].
  const place = (cx, text, px) => {
    const w = [...text].length * px;
    const x = Math.min(Math.max(cx, left + w / 2), W - right - w / 2);
    return [x, x - w / 2, x + w / 2];
  };
  items.forEach((d, i) => {
    const x = left + i * step + (step - bw) / 2;
    const cx = x + bw / 2;
    if (d.pct !== null && d.pct !== undefined) {
      const y = yScale(d.pct);
      const h = Math.max(2, Math.abs(y - y0));
      const down = d.pct < 0;
      const cls = d.past ? "bar-past" : d.pct <= -5 ? "bar-down" : d.pct >= 5 ? "bar-up" : "bar-flat";
      const isPick = !d.past && state.pick?.status === "ok" && d.idx === state.pick.index;
      const rect = el("rect", { x, y: down ? y0 : y0 - h, width: bw, height: h, rx: 2,
        class: `bar ${cls}${isPick ? " bar-pick" : ""}${animate ? ` grow ${down ? "down" : "up"}` : ""}`, tabindex: 0 });
      if (animate) rect.style.animationDelay = `${i * 18}ms`;
      const label = d.past
        ? fill(t().chart_week_past, { range: fmtRange(d.start, d.end), pct: pctWords(d.pct), n: num(d.n) })
        : fill(t().chart_week, { range: fmtRange(d.start, d.end), pct: pctWords(d.pct), lo: num(d.lo), hi: num(d.hi) }) + festSuffix(d.festive);
      rect.appendChild(el("title", {}, label));
      const show = () => { $("chart-detail").textContent = label; };
      rect.addEventListener("click", show);
      rect.addEventListener("focus", show);
      svg.appendChild(rect);
      desc.push(label);
      if (!d.past) {
        svg.appendChild(el("line", { x1: cx, x2: cx, y1: yScale(d.hiPct), y2: yScale(d.loPct), class: "whisker" })); // yScale clamps to the plot
      }
      if (isPick) {
        svg.appendChild(el("text", { x: cx, y: Math.min(y0, y) - 10, "text-anchor": "middle", class: "lbl-pick" }, t().legend_pick));
      }
    }
    // Month label when the month changes
    const m = parseDate(d.start).getMonth();
    if (m !== lastMonth) {
      const mText = new Intl.DateTimeFormat(loc(), { month: "short" }).format(parseDate(d.start));
      const [mx] = place(cx, mText, 7);
      svg.appendChild(el("text", { x: mx, y: H - 6, "text-anchor": "middle", class: "lbl" }, mText));
      lastMonth = m;
    }
    // Festive label at the first week of each run
    if (d.festive && d.festive !== lastFest && d.festive !== "post_raya") {
      const text = t().fest[d.festive];
      const px = state.lang === "zh" ? 11 : state.lang === "ta" ? 7.5 : 6.3;
      const [fx, l, r] = place(cx, text, px);
      const row = l > rowEnd[0] + 6 ? 0 : 1;
      rowEnd[row] = r;
      svg.appendChild(el("text", { x: fx, y: H - 26 - row * 14, "text-anchor": "middle", class: "lbl-fest" }, text));
    }
    lastFest = d.festive;
  });
  $("tide-h").textContent = fill(t().chart_heading, { area: areaName(state.area) });
  svg.setAttribute("aria-label", desc.join(". "));
  const lg = $("legend");
  lg.innerHTML = "";
  for (const [cls, key, kind] of [["#B9C4BF", "legend_past", ""], ["#8E1B2E", "legend_low", ""], ["#8FA099", "legend_other", ""],
    ["#D9A92E", "legend_pick", "ring"], ["#1C2633", "legend_usual", "line"]]) {
    const li = document.createElement("li");
    li.innerHTML = `<i class="${kind}" style="background:${cls}"></i>`;
    li.append(t()[key]);
    lg.appendChild(li);
  }
}

// ------------------------------------------------------------------ pulse, why, trust
function renderPulse() {
  const p = state.data.pulse;
  const rows = [["Malaysia", "all", areaName("Malaysia")]];
  if (state.area !== "Malaysia") rows.push([state.area, "all", areaName(state.area)]);
  if (state.type !== "all") rows.push([state.area, state.type, fill(t().pulse_type, { area: areaName(state.area), type: typeName(state.type) })]);
  const dl = $("pulse");
  dl.innerHTML = "";
  for (const [a, ty, label] of rows) {
    const r = p[a]?.[ty];
    if (!r) continue;
    const div = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = pctWords(r.d28_vs_year_pct);
    if (r.d28_vs_year_pct <= -3) dd.className = "down";
    div.append(dt, dd); dl.appendChild(div);
  }
}

function renderProse() {
  const m = state.data.meta;
  const sp = m.seasonal_profile || [];
  const ram = sp.filter((s) => s.festive === "ramadan").map((s) => s.change_pct);
  const cny = sp.filter((s) => s.festive === "cny").map((s) => s.change_pct);
  const rr = range(ram.map((x) => -x)), cr = range(cny.map((x) => -x));
  $("why-p2").textContent = rr && cr ? fill(t().why_p2, { n: ram.length, min: rr.min, max: rr.max, cmin: cr.min, cmax: cr.max }) : "";
  const bt = m.backtest;
  const a = bt.areas_wape_all_horizons;
  $("trust-p1").textContent = fill(t().trust_p1, { weeks: bt.period.weeks, model: bt.national_mape_h1.model, naive: bt.national_mape_h1.last_week });
  $("trust-p2").textContent = fill(t().trust_p2, { m: a.model, b: Math.min(a.last_week, a.mean_4wk, a.same_week_last_year) });
  const tbl = $("examples");
  tbl.innerHTML = "";
  const head = tbl.createTHead().insertRow();
  for (const k of ["col_week", "col_actual", "col_model", "col_ly"]) { const th = document.createElement("th"); th.textContent = t()[k]; head.appendChild(th); }
  const cap = tbl.createCaption(); cap.className = "hint"; cap.textContent = t().closer_note;
  const body = tbl.createTBody();
  for (const e of bt.festive_examples_8wk || []) {
    const r = body.insertRow();
    r.insertCell().textContent = fmtDate(e.week_end, { day: "numeric", month: "short", year: "numeric" }) + fill(t().paren, { x: t().fest[e.festive] });
    r.insertCell().textContent = num(e.actual);
    const cm = r.insertCell(); cm.textContent = num(e.model);
    const cl = r.insertCell(); cl.textContent = num(e.same_week_last_year);
    (Math.abs(e.model - e.actual) <= Math.abs(e.same_week_last_year - e.actual) ? cm : cl).className = "close";
  }
  $("asof").textContent = fill(t().data_as_of, {
    date: fmtDate(m.data_as_of),
    gen: new Intl.DateTimeFormat(loc(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(m.generated_at)),
  });
  const gh = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (gh) {
    const repo = location.pathname.split("/").filter(Boolean)[0];
    $("code-link").href = `https://github.com/${gh[1]}/${repo || ""}`;
  }
}

// ------------------------------------------------------------------ render + boot
let resizeTimer, lastWidth = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = $("chart").clientWidth;
    if (state.data && Math.abs(w - lastWidth) > 40) { lastWidth = w; renderChart(false); }
  }, 150);
});

function renderResults(animate = false) {
  renderAnswer();
  renderChart(animate);
  renderPulse();
}
function renderAll() {
  applyText();
  renderResults();
  renderProse();
}

async function boot() {
  loadPrefs();
  try {
    const get = (f) => fetch(`data/${f}.json`, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
    const [meta, pulse, forecast, history] = await Promise.all(["meta", "pulse", "forecast", "history"].map(get));
    state.data = { meta, pulse, forecast, history };
  } catch {
    document.documentElement.lang = state.lang;
    $("error").hidden = false;
    $("error").textContent = T[state.lang].load_error;
    return;
  }
  if (!TYPES.includes(state.type)) state.type = "all";
  if (![3, 4].includes(Number(state.interval))) state.interval = 3;
  applyText();
  bindForm();
  renderResults(true);
  renderProse();
}

boot();
