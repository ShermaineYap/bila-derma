// Heatmap and state tile map. Pure rendering helpers; text comes in from app.js.

const STOPS = [
  [-40, [142, 27, 46]],   // vein
  [-12, [214, 150, 160]],
  [0, [240, 243, 241]],
  [12, [171, 202, 189]],
  [40, [46, 98, 82]],
];

/** Diverging colour for a % change vs usual: red below, green above. */
export function pctColor(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "#DDE3DF";
  const v = Math.max(STOPS[0][0], Math.min(STOPS[STOPS.length - 1][0], pct));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    const [p0, c0] = STOPS[i - 1];
    if (v <= p1) {
      const f = (v - p0) / (p1 - p0);
      const c = c0.map((x, k) => Math.round(x + (c1[k] - x) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(46,98,82)";
}

/** Text colour that stays readable on pctColor(pct). */
export const inkOn = (pct) => (pct !== null && pct !== undefined && Math.abs(pct) >= 22 ? "#FFFFFF" : "#1C2633");

// Rough geographic layout: [area, short code, col, row]. Perlis and Labuan have no data.
export const TILES = [
  ["Perlis", "PLS", 1, 0],
  ["Pulau Pinang", "PNG", 0, 1], ["Kedah", "KDH", 1, 1], ["Kelantan", "KTN", 2, 1],
  ["Perak", "PRK", 1, 2], ["Pahang", "PHG", 2, 2], ["Terengganu", "TRG", 3, 2],
  ["Klang Valley", "KV", 1, 3], ["Negeri Sembilan", "NSN", 2, 3],
  ["Melaka", "MLK", 2, 4], ["Johor", "JHR", 3, 4],
  ["W.P. Labuan", "LBN", 5, 1], ["Sabah", "SBH", 6, 1], ["Sarawak", "SWK", 5, 2],
];

/**
 * Render the tile map into `root` (an HTML element). opts:
 *  pulse, selected, nameOf(area), pctText(pct), noData, onPick(area)
 */
export function renderTileMap(root, { pulse, selected, nameOf, pctText, noData, onPick }) {
  root.innerHTML = "";
  for (const [area, code, col, row] of TILES) {
    const rec = pulse[area]?.all;
    const pct = rec ? rec.d28_vs_year_pct : null;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tile" + (area === selected ? " is-selected" : "") + (rec ? "" : " is-empty");
    b.style.gridColumn = String(col + 1);
    b.style.gridRow = String(row + 1);
    b.style.background = pctColor(pct);
    b.style.color = inkOn(pct);
    const label = `${nameOf(area)}: ${rec ? pctText(pct) : noData}`;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.setAttribute("aria-pressed", String(area === selected));
    b.innerHTML = `<span class="tile-code"></span><span class="tile-pct"></span>`;
    b.querySelector(".tile-code").textContent = code;
    b.querySelector(".tile-pct").textContent = rec ? `${pct > 0 ? "+" : ""}${Math.round(pct)}%` : "–";
    if (rec) b.addEventListener("click", () => onPick(area));
    else b.disabled = true;
    root.appendChild(b);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}, text) => {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * Year x ISO-week heatmap. opts: data (heatmap.json), cellLabel(year, week, pct), monthNames[12], onDetail(text)
 */
export function renderHeatmap(svg, { data, cellLabel, monthNames, onDetail }) {
  svg.innerHTML = "";
  const cell = 12, gap = 1.5, left = 40, top = 22, rows = data.years.length;
  const W = left + 53 * (cell + gap) + 4;
  const H = top + rows * (cell + gap) + 6;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  // Month labels: ISO week in which each month starts (approximate, using a non-leap year).
  for (let m = 0; m < 12; m++) {
    const day = new Date(2026, m, 1);
    const wk = Math.floor((day - new Date(2026, 0, 1)) / (7 * 864e5));
    svg.appendChild(el("text", { x: left + wk * (cell + gap), y: 12, class: "hm-lbl" }, monthNames[m]));
  }
  const marks = data.marks;
  data.years.forEach((year, r) => {
    const y = top + r * (cell + gap);
    if (r % 2 === 0 || r === rows - 1) {
      svg.appendChild(el("text", { x: left - 6, y: y + cell - 2, "text-anchor": "end", class: "hm-lbl" }, String(year)));
    }
    const vals = data.cells[String(year)];
    const ram = new Set(marks.ramadan[String(year)] || []);
    const raya = new Set(marks.raya[String(year)] || []);
    const cny = new Set(marks.cny[String(year)] || []);
    vals.forEach((pct, w) => {
      if (pct === null) return;
      const x = left + w * (cell + gap);
      const rect = el("rect", { x, y, width: cell, height: cell, rx: 2, fill: pctColor(pct), class: "hm-cell", tabindex: -1 });
      const label = cellLabel(year, w + 1, pct, { ramadan: ram.has(w + 1), raya: raya.has(w + 1), cny: cny.has(w + 1) });
      rect.appendChild(el("title", {}, label));
      rect.addEventListener("click", () => onDetail(label));
      rect.addEventListener("mouseenter", () => onDetail(label));
      svg.appendChild(rect);
      const cx = x + cell / 2, cy = y + cell / 2;
      if (ram.has(w + 1)) svg.appendChild(el("circle", { cx, cy, r: 2.2, class: "hm-ramadan" }));
      if (raya.has(w + 1)) svg.appendChild(el("rect", { x: x + 0.75, y: y + 0.75, width: cell - 1.5, height: cell - 1.5, rx: 2, class: "hm-raya" }));
      if (cny.has(w + 1)) svg.appendChild(el("circle", { cx, cy, r: 2.6, class: "hm-cny" }));
    });
  });
}
