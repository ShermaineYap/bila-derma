// Pure functions used by the app. No DOM access, so they can be tested in Node.

/** Parse YYYY-MM-DD as a local date at noon (avoids timezone day shifts). */
export function parseDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

export function isoDate(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export function addDays(dt, n) {
  const r = new Date(dt);
  r.setDate(r.getDate() + n);
  return r;
}

/** Add calendar months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(dt, n) {
  const r = new Date(dt.getFullYear(), dt.getMonth() + n, 1, 12);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0, 12).getDate();
  r.setDate(Math.min(dt.getDate(), last));
  return r;
}

/**
 * First date the donor can give again. With no last donation, they can give today.
 * The interval is whatever the donation centre told them (default 3 months for whole blood).
 */
export function nextEligible(lastDonation, months, today) {
  if (!lastDonation) return today;
  const due = addMonths(lastDonation, months);
  return due > today ? due : today;
}

/**
 * Choose the week to donate.
 * weeks:    [{week_start, week_end, festive, holidays:[{date,name}]}]
 * forecast: [{pred, lo, hi, vs_usual_pct}] aligned with weeks
 * Rules:
 *  - Only weeks that end on or after the eligible date, and start within `windowWeeks` weeks of it.
 *  - Pick the week whose forecast is furthest below the usual level.
 *  - If that week holds 2+ public holidays (centres may close), recommend the eligible week
 *    before it instead: red cells keep 35-42 days, so blood given then still covers the dip.
 */
export function pickWeek(weeks, forecast, eligible, { windowWeeks = 8 } = {}) {
  if (!weeks?.length || !forecast?.length) return { status: "no_data" };
  const lastEnd = parseDate(weeks[weeks.length - 1].week_end);
  if (eligible > lastEnd) return { status: "beyond_forecast", eligible: isoDate(eligible) };
  const windowEnd = addDays(eligible, windowWeeks * 7);
  const candidates = [];
  weeks.forEach((w, i) => {
    const start = parseDate(w.week_start);
    const end = parseDate(w.week_end);
    if (end >= eligible && start <= windowEnd && forecast[i]) candidates.push(i);
  });
  if (!candidates.length) return { status: "no_data" };
  let best = candidates[0];
  for (const i of candidates) {
    if (forecast[i].vs_usual_pct < forecast[best].vs_usual_pct) best = i;
  }
  const holidaysIn = (i) => (weeks[i].holidays || []).length;
  let index = best;
  let reason = "lowest";
  if (holidaysIn(best) >= 2 && candidates.includes(best - 1)) {
    index = best - 1;
    reason = "before_holiday";
  }
  const dipNotable = forecast[best].vs_usual_pct <= -5;
  if (!dipNotable) reason = "no_dip";
  return { status: "ok", index, dipIndex: best, reason, eligible: isoDate(eligible) };
}

/** Bucket a percentage change into words the UI can translate. */
export function describePct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return { key: "unknown", value: 0 };
  const v = Math.round(Math.abs(pct));
  if (Math.abs(pct) < 3) return { key: "about_usual", value: v };
  return { key: pct < 0 ? "below_usual" : "above_usual", value: v };
}

/** All-day calendar event covering the chosen week (iCalendar, RFC 5545). */
export function buildIcs({ weekStart, weekEnd, title, description, now = new Date() }) {
  const s = parseDate(weekStart);
  const e = addDays(parseDate(weekEnd), 1);
  const compact = (d) => isoDate(d).replace(/-/g, "");
  const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bila Derma//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:bila-derma-${compact(s)}@bila-derma`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compact(s)}`,
    `DTEND;VALUE=DATE:${compact(e)}`,
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(description)}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** For past weeks: each week's count relative to the mean of the 52 weeks before it. */
export function pastVsUsual(counts, lookback = 52) {
  const out = [];
  for (let i = 0; i < counts.length; i++) {
    if (i < lookback) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += counts[j];
    const usual = sum / lookback;
    out.push(usual > 0 ? ((counts[i] / usual) - 1) * 100 : null);
  }
  return out;
}

/** Range of a list of numbers, rounded, for sentences like "fell 14-31%". */
export function range(values) {
  const v = values.filter((x) => typeof x === "number");
  if (!v.length) return null;
  return { min: Math.round(Math.min(...v)), max: Math.round(Math.max(...v)) };
}
