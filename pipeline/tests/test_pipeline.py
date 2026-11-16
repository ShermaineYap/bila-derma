"""Unit tests for the pipeline. Run: python -m pytest pipeline/tests -q"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build  # noqa: E402
from calendar_features import festive_dates, week_features  # noqa: E402


def test_festive_dates_known_years():
    f = festive_dates(2025, 2027)
    raya = {d.isoformat() for d in f["raya"]}
    cny = {d.isoformat() for d in f["cny"]}
    assert "2026-03-21" in raya and "2025-03-31" in raya
    assert "2026-02-17" in cny and "2027-02-06" in cny


def test_week_features_ramadan_and_cny():
    weeks = pd.DatetimeIndex(["2026-03-01", "2026-02-22", "2026-07-05"])
    f = week_features(weeks)
    assert f.loc["2026-03-01", "ramadan"] == 7          # full Ramadan week
    assert f.loc["2026-02-22", "cny"] >= 6              # CNY 17 Feb 2026
    assert f.loc["2026-07-05"].drop(["woy", "public_holidays"]).sum() == 0


def _toy_daily():
    days = pd.date_range("2024-01-01", "2026-11-15", freq="D")
    rows = []
    for area in ["Malaysia", "Johor"]:
        for bt in build.TYPES:
            base = 100 if area == "Malaysia" else 20
            for d in days:
                rows.append((d, area, bt, base + (d.dayofweek == 6) * 10))
    return pd.DataFrame(rows, columns=["date", "area", "blood_type", "donations"])


def test_weekly_drops_incomplete_week():
    daily = build.to_daily_wide(_toy_daily())
    weekly = build.to_weekly(daily)
    assert weekly.index.max() == pd.Timestamp("2026-11-15")      # a Sunday, complete week
    daily2 = daily.iloc[:-3]                                      # ends on Thursday
    weekly2 = build.to_weekly(daily2)
    assert weekly2.index.max() == pd.Timestamp("2026-11-08")


def test_make_rows_has_no_future_leakage():
    daily = build.to_daily_wide(_toy_daily())
    weekly = build.to_weekly(daily)
    cal = week_features(weekly.index.union(pd.date_range(weekly.index[-1] + pd.Timedelta(weeks=1), periods=build.HORIZON, freq="W-SUN")))
    # Spike the very last week; rows whose origin is before it must not see it in r1/r4/ly.
    w2 = weekly.copy()
    w2.iloc[-1] = w2.iloc[-1] * 10
    rows_a = build.make_rows(weekly, cal, origins=[len(weekly) - 5], horizons=[1])
    rows_b = build.make_rows(w2, cal, origins=[len(weekly) - 5], horizons=[1])
    for col in ["r1", "r4", "ly", "level"]:
        np.testing.assert_allclose(rows_a[col], rows_b[col])
    # Target for h=4 from origin n-5 is the spiked week.
    rows_c = build.make_rows(w2, cal, origins=[len(weekly) - 5], horizons=[4])
    assert (rows_c["y"].to_numpy() == w2.iloc[-1].to_numpy()[rows_c["series"].to_numpy()]).all()


def test_metrics():
    assert build.mape([100, 200], [110, 180]) == 10.0
    assert round(build.wape([100, 300], [110, 270]), 6) == 10.0
