"""Festive-calendar features for weekly blood donation forecasting.

Weeks run Monday to Sunday and are labelled by their Sunday (pandas 'W-SUN').
Festive dates come from the `holidays` package (Malaysia, W.P. Kuala Lumpur).
Ramadan is approximated as the 30 days before Hari Raya Puasa; at weekly
resolution a one-day difference does not matter.
"""
from __future__ import annotations

import datetime as dt
from functools import lru_cache

import holidays
import pandas as pd

COVID_START = pd.Timestamp("2020-03-16")
COVID_END = pd.Timestamp("2021-10-31")


@lru_cache(maxsize=None)
def _holidays(first_year: int, last_year: int) -> dict[dt.date, str]:
    return dict(holidays.Malaysia(years=range(first_year, last_year + 1), subdiv="KUL"))


def festive_dates(first_year: int, last_year: int) -> dict[str, list[dt.date]]:
    """Main date of each festival per year."""
    h = _holidays(first_year, last_year)
    out: dict[str, list[dt.date]] = {"raya": [], "cny": [], "deepavali": [], "haji": []}
    for d, name in sorted(h.items()):
        for part in name.split("; "):
            if part == "Hari Raya Puasa":
                out["raya"].append(d)
            elif part == "Tahun Baharu Cina":
                out["cny"].append(d)
            elif part == "Hari Deepavali":
                out["deepavali"].append(d)
            elif part == "Hari Raya Qurban":
                out["haji"].append(d)
    return out


def _windows(first_year: int, last_year: int) -> dict[str, list[tuple[dt.date, dt.date]]]:
    f = festive_dates(first_year, last_year)
    td = dt.timedelta
    return {
        "ramadan": [(r - td(days=30), r - td(days=1)) for r in f["raya"]],
        "raya": [(r, r + td(days=6)) for r in f["raya"]],
        "post_raya": [(r + td(days=7), r + td(days=20)) for r in f["raya"]],
        "cny": [(c - td(days=3), c + td(days=6)) for c in f["cny"]],
        "deepavali": [(d - td(days=2), d + td(days=2)) for d in f["deepavali"]],
        "haji": [(h - td(days=1), h + td(days=3)) for h in f["haji"]],
        "year_end": [(dt.date(y - 1, 12, 24), dt.date(y, 1, 1)) for y in range(first_year, last_year + 1)],
    }


FEATURES = ["ramadan", "raya", "post_raya", "cny", "deepavali", "haji", "year_end"]


def week_features(week_ends: pd.DatetimeIndex) -> pd.DataFrame:
    """Return one row per week: days overlapping each festive window, public holidays, COVID flag."""
    week_ends = pd.DatetimeIndex(week_ends)
    y0, y1 = int(week_ends.min().year) - 1, int(week_ends.max().year) + 1
    wins = _windows(y0, y1)
    hol = _holidays(y0, y1)
    rows = []
    for we in week_ends:
        end = we.date()
        days = [end - dt.timedelta(days=i) for i in range(7)]
        row = {"week_end": we}
        for key in FEATURES:
            row[key] = sum(any(a <= d <= b for a, b in wins[key]) for d in days)
        row["public_holidays"] = sum(d in hol for d in days)
        row["covid"] = int(COVID_START <= we <= COVID_END)
        row["woy"] = int(we.isocalendar().week)
        rows.append(row)
    return pd.DataFrame(rows).set_index("week_end")


def week_labels(week_end: pd.Timestamp) -> list[dict]:
    """Public holidays falling in a week, for display."""
    end = week_end.date()
    hol = _holidays(end.year - 1, end.year + 1)
    out = []
    for i in range(6, -1, -1):
        d = end - dt.timedelta(days=i)
        if d in hol:
            out.append({"date": d.isoformat(), "name": hol[d]})
    return out


def festive_label(row: pd.Series) -> str | None:
    """Short machine label for the dominant festive period in a week."""
    if row.get("raya", 0) >= 1:          # the week containing Hari Raya itself
        return "raya"
    for key in ["cny", "ramadan", "deepavali", "haji", "year_end", "post_raya"]:
        if row.get(key, 0) >= 3:
            return key
    return None
