import test from "node:test";
import assert from "node:assert/strict";
import { parseDate, isoDate, addMonths, nextEligible, pickWeek, describePct, buildIcs, pastVsUsual, range } from "../site/js/logic.js";

const d = (s) => parseDate(s);

test("parseDate rejects invalid dates", () => {
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("nope"), null);
  assert.equal(isoDate(parseDate("2026-11-16")), "2026-11-16");
});

test("addMonths clamps to month end", () => {
  assert.equal(isoDate(addMonths(d("2026-11-30"), 3)), "2027-02-28");
  assert.equal(isoDate(addMonths(d("2027-11-30"), 3)), "2028-02-29");
  assert.equal(isoDate(addMonths(d("2026-08-15"), 3)), "2026-11-15");
});

test("nextEligible uses today when no last donation or already due", () => {
  const today = d("2026-11-16");
  assert.equal(isoDate(nextEligible(null, 3, today)), "2026-11-16");
  assert.equal(isoDate(nextEligible(d("2026-01-01"), 3, today)), "2026-11-16");
  assert.equal(isoDate(nextEligible(d("2026-10-01"), 3, today)), "2027-01-01");
  assert.equal(isoDate(nextEligible(d("2026-10-01"), 4, today)), "2027-02-01");
});

function weeksFrom(start, n) {
  const out = [];
  let s = d(start);
  for (let i = 0; i < n; i++) {
    const e = new Date(s); e.setDate(e.getDate() + 6);
    out.push({ week_start: isoDate(s), week_end: isoDate(e), festive: null, holidays: [] });
    s = new Date(s); s.setDate(s.getDate() + 7);
  }
  return out;
}
const fc = (pcts) => pcts.map((p) => ({ pred: 100, lo: 80, hi: 120, vs_usual_pct: p }));

test("pickWeek picks the deepest dip within the window", () => {
  const weeks = weeksFrom("2026-11-16", 16);
  const pcts = [0, 1, -2, 0, -3, -10, -22, 0, 0, 0, 0, -16, -30, 0, 0, 0];
  const r = pickWeek(weeks, fc(pcts), d("2026-11-16"));
  assert.equal(r.status, "ok");
  assert.equal(r.index, 6);
  assert.equal(r.reason, "lowest");
});

test("pickWeek respects eligibility date", () => {
  const weeks = weeksFrom("2026-11-16", 16);
  const pcts = [-40, 0, 0, 0, 0, 0, 0, 0, 0, 0, -12, 0, 0, 0, 0, 0];
  const r = pickWeek(weeks, fc(pcts), d("2027-01-10"));
  assert.equal(r.index, 10);
});

test("pickWeek moves to the week before a holiday-heavy dip", () => {
  const weeks = weeksFrom("2026-11-16", 16);
  weeks[6].holidays = [{ date: "2026-12-25", name: "Hari Krismas" }, { date: "2027-01-01", name: "Tahun Baharu" }];
  const pcts = [0, 0, 0, 0, 0, -5, -25, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = pickWeek(weeks, fc(pcts), d("2026-11-16"));
  assert.equal(r.reason, "before_holiday");
  assert.equal(r.index, 5);
  assert.equal(r.dipIndex, 6);
});

test("pickWeek says no_dip when nothing is notably low", () => {
  const weeks = weeksFrom("2026-11-16", 16);
  const r = pickWeek(weeks, fc(new Array(16).fill(1).map((x, i) => (i === 3 ? -2 : 1))), d("2026-11-16"));
  assert.equal(r.reason, "no_dip");
  assert.equal(r.index, 3);
});

test("pickWeek reports when eligibility is beyond the forecast", () => {
  const weeks = weeksFrom("2026-11-16", 16);
  const r = pickWeek(weeks, fc(new Array(16).fill(0)), d("2027-06-01"));
  assert.equal(r.status, "beyond_forecast");
  assert.equal(r.eligible, "2027-06-01");
});

test("describePct buckets", () => {
  assert.deepEqual(describePct(-16.2), { key: "below_usual", value: 16 });
  assert.deepEqual(describePct(2.4), { key: "about_usual", value: 2 });
  assert.deepEqual(describePct(7.7), { key: "above_usual", value: 8 });
  assert.equal(describePct(null).key, "unknown");
});

test("buildIcs produces an all-day event spanning the week", () => {
  const ics = buildIcs({ weekStart: "2027-02-01", weekEnd: "2027-02-07", title: "Donate, blood", description: "a;b", now: new Date("2026-11-16T00:00:00Z") });
  assert.match(ics, /DTSTART;VALUE=DATE:20270201/);
  assert.match(ics, /DTEND;VALUE=DATE:20270208/);
  assert.match(ics, /SUMMARY:Donate\\, blood/);
  assert.match(ics, /DESCRIPTION:a\\;b/);
  assert.ok(ics.includes("\r\n"));
});

test("pastVsUsual compares with trailing mean", () => {
  const counts = new Array(52).fill(100).concat([80, 120]);
  const r = pastVsUsual(counts);
  assert.equal(r[51], null);
  assert.equal(Math.round(r[52]), -20);
  assert.ok(Math.abs(r[53] - (120 / (100 * 51 / 52 + 80 / 52) - 1) * 100) < 1e-9);
});

test("range rounds min and max", () => {
  assert.deepEqual(range([14.3, 30.8, 21.6]), { min: 14, max: 31 });
  assert.equal(range([]), null);
});
