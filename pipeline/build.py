"""Bila Derma data pipeline.

Downloads the Ministry of Health's daily blood donation data, builds weekly
series per area and blood group, trains a direct multi-horizon forecasting
model, backtests it against naive baselines, and writes JSON for the web app.

Usage:
    python pipeline/build.py                 # download from data.gov.my
    DATA_DIR=path python pipeline/build.py   # use local CSV copies
    OUT_DIR=site/data (default)
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from calendar_features import FEATURES, festive_label, week_features, week_labels  # noqa: E402

NATIONAL_URL = "https://storage.data.gov.my/healthcare/blood_donations.csv"
STATE_URL = "https://storage.data.gov.my/healthcare/blood_donations_state.csv"
TYPES = ["all", "o", "a", "b", "ab"]
KLANG_VALLEY = {"Selangor", "W.P. Kuala Lumpur"}
HORIZON = 16
TRAIN_FROM = pd.Timestamp("2015-01-04")
BACKTEST_WEEKS = 104
RETRAIN_EVERY = 13
SEED = 7


# --------------------------------------------------------------------------- data

def load_daily(data_dir: str | None = None) -> pd.DataFrame:
    """Long daily table: date, area, blood_type, donations."""
    nat_src = Path(data_dir) / "blood_donations.csv" if data_dir else NATIONAL_URL
    st_src = Path(data_dir) / "blood_donations_state.csv" if data_dir else STATE_URL
    nat = pd.read_csv(nat_src, parse_dates=["date"])
    nat["area"] = "Malaysia"
    st = pd.read_csv(st_src, parse_dates=["date"])
    st["area"] = st["state"].where(~st["state"].isin(KLANG_VALLEY), "Klang Valley")
    st = st.groupby(["date", "area", "blood_type"], as_index=False)["donations"].sum()
    df = pd.concat([nat[["date", "area", "blood_type", "donations"]], st], ignore_index=True)
    df["blood_type"] = df["blood_type"].str.lower()
    return df[df["blood_type"].isin(TYPES)]


def to_daily_wide(df: pd.DataFrame) -> pd.DataFrame:
    """Columns = (area, type); rows = every calendar day; missing days = 0."""
    wide = df.pivot_table(index="date", columns=["area", "blood_type"], values="donations", aggfunc="sum")
    idx = pd.date_range(wide.index.min(), wide.index.max(), freq="D")
    return wide.reindex(idx).fillna(0.0)


def to_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """Complete Monday-Sunday weeks only, labelled by Sunday."""
    last = daily.index.max()
    weekly = daily.resample("W-SUN").sum()
    weekly = weekly[weekly.index <= last]
    return weekly[weekly.index >= TRAIN_FROM - pd.Timedelta(weeks=60)]


# --------------------------------------------------------------------------- features

def make_rows(weekly: pd.DataFrame, cal: pd.DataFrame, origins: list[int] | None = None,
              horizons=range(1, HORIZON + 1), need_target: bool = True) -> pd.DataFrame:
    """Direct multi-horizon design matrix.

    One row per (series, origin week t, horizon h). Target is y[t+h] / level_t,
    where level_t is the mean of the 52 weeks ending at t. Only information known
    at t (plus the calendar of the target week) is used.
    """
    y = weekly.to_numpy(dtype=float)  # (weeks, series)
    n_weeks, n_series = y.shape
    weeks = weekly.index
    cal = cal.reindex(weeks.union(pd.date_range(weeks[-1] + pd.Timedelta(weeks=1), periods=HORIZON, freq="W-SUN")))
    cal_arr = {c: cal[c].to_numpy() for c in FEATURES + ["public_holidays", "covid", "woy"]}
    level = pd.DataFrame(y).rolling(52, min_periods=52).mean().to_numpy()
    r4 = pd.DataFrame(y).rolling(4).mean().to_numpy()
    areas = [c[0] for c in weekly.columns]
    types = [c[1] for c in weekly.columns]
    area_codes = {a: i for i, a in enumerate(sorted(set(areas)))}
    type_codes = {t: i for i, t in enumerate(TYPES)}
    if origins is None:
        origins = list(range(52 + 52, n_weeks))
    blocks = []
    for h in horizons:
        for t in origins:
            tgt = t + h
            if need_target and tgt >= n_weeks:
                continue
            lv = level[t]
            ok = lv > 0
            if not ok.any():
                continue
            s_idx = np.nonzero(ok)[0]
            lvs = lv[s_idx]
            blk = {
                "series": s_idx,
                "t": np.full(len(s_idx), t),
                "h": np.full(len(s_idx), h),
                "area": [area_codes[areas[i]] for i in s_idx],
                "btype": [type_codes[types[i]] for i in s_idx],
                "log_level": np.log1p(lvs),
                "r1": y[t, s_idx] / lvs,
                "r4": r4[t, s_idx] / lvs,
                "ly": y[tgt - 52, s_idx] / lvs,
            }
            for c, arr in cal_arr.items():
                blk[c] = np.full(len(s_idx), arr[tgt])
                if c in FEATURES:
                    blk[c + "_ly"] = np.full(len(s_idx), arr[tgt - 52])
            blk["covid_t"] = np.full(len(s_idx), cal_arr["covid"][t])
            if need_target:
                blk["y"] = y[tgt, s_idx]
                blk["target"] = y[tgt, s_idx] / lvs
            blk["level"] = lvs
            blocks.append(pd.DataFrame(blk))
    return pd.concat(blocks, ignore_index=True)


FEATURE_COLS = (["h", "area", "btype", "log_level", "r1", "r4", "ly"] + FEATURES + [f + "_ly" for f in FEATURES]
                + ["public_holidays", "covid", "covid_t", "woy"])


def fit(rows: pd.DataFrame) -> HistGradientBoostingRegressor:
    rows = rows[(rows["covid"] == 0) & (rows["covid_t"] == 0)]
    model = HistGradientBoostingRegressor(
        loss="absolute_error", learning_rate=0.05, max_iter=400, max_leaf_nodes=31,
        min_samples_leaf=40, l2_regularization=1.0, categorical_features=[1, 2], random_state=SEED,
    )
    # Weight by series volume so tiny noisy series do not dominate.
    w = np.sqrt(rows["level"].to_numpy())
    model.fit(rows[FEATURE_COLS], rows["target"], sample_weight=w)
    return model


# --------------------------------------------------------------------------- backtest

def backtest(weekly: pd.DataFrame, cal: pd.DataFrame, all_rows: pd.DataFrame) -> pd.DataFrame:
    """Rolling-origin backtest over the last BACKTEST_WEEKS target weeks.

    The model is retrained every RETRAIN_EVERY weeks using only rows whose target
    week is on or before the retrain cutoff. Predictions are made for origins
    after the cutoff.
    """
    n = len(weekly)
    first_target = n - BACKTEST_WEEKS
    preds = []
    for cut in range(first_target - 1, n - 1, RETRAIN_EVERY):
        train = all_rows[all_rows["t"] + all_rows["h"] <= cut]
        model = fit(train)
        test = all_rows[(all_rows["t"] >= cut) & (all_rows["t"] < cut + RETRAIN_EVERY)
                        & (all_rows["t"] + all_rows["h"] >= first_target)]
        if test.empty:
            continue
        p = test[["series", "t", "h", "y", "level", "r1", "r4", "ly"]].copy()
        p["model"] = model.predict(test[FEATURE_COLS]) * p["level"]
        preds.append(p)
    out = pd.concat(preds, ignore_index=True)
    out["last_week"] = out["r1"] * out["level"]
    out["mean_4wk"] = out["r4"] * out["level"]
    out["same_week_last_year"] = out["ly"] * out["level"]
    out["series_name"] = [weekly.columns[i] for i in out["series"]]
    return out


def wape(actual, pred) -> float:
    actual, pred = np.asarray(actual, float), np.asarray(pred, float)
    return float(np.abs(actual - pred).sum() / actual.sum() * 100)


def mape(actual, pred) -> float:
    actual, pred = np.asarray(actual, float), np.asarray(pred, float)
    m = actual > 0
    return float(np.mean(np.abs(actual[m] - pred[m]) / actual[m]) * 100)


METHODS = ["model", "last_week", "mean_4wk", "same_week_last_year"]


def summarise_backtest(bt: pd.DataFrame, weekly: pd.DataFrame, cal: pd.DataFrame) -> dict:
    nat = bt[bt["series_name"] == ("Malaysia", "all")]
    areas_all = bt[[(s[1] == "all" and s[0] != "Malaysia") for s in bt["series_name"]]]
    by_h = []
    for h in range(1, HORIZON + 1):
        d = nat[nat["h"] == h]
        by_h.append({"h": h, **{m: round(mape(d["y"], d[m]), 1) for m in METHODS}})
    nat_overall = {m: round(mape(nat["y"], nat[m]), 1) for m in METHODS}
    nat_h1 = by_h[0]
    areas = {m: round(wape(areas_all["y"], areas_all[m]), 1) for m in METHODS}
    per_area = []
    for name, d in areas_all.groupby("series_name"):
        per_area.append({"area": name[0], **{m: round(wape(d["y"], d[m]), 1) for m in METHODS}})
    # Empirical 80% interval per series: 10th and 90th percentile of actual / model
    # over every backtest prediction for that series (all horizons pooled).
    intervals = {}
    for name, d in bt[bt["model"] > 0].groupby("series_name"):
        r = d["y"] / d["model"]
        intervals.setdefault(name[0], {})[name[1]] = {"lo": round(float(r.quantile(0.1)), 3),
                                                      "hi": round(float(r.quantile(0.9)), 3)}
    by_type = []
    for btype in TYPES:
        d = bt[[s == ("Malaysia", btype) for s in bt["series_name"]]]
        by_type.append({"blood_type": btype, **{m: round(mape(d["y"], d[m]), 1) for m in METHODS}})
    # Festive weeks forecast 8 weeks ahead: did the model see the dip coming?
    examples = []
    for _, r in nat[nat["h"] == 8].iterrows():
        we = weekly.index[int(r["t"] + r["h"])]
        lab = festive_label(cal.loc[we])
        if lab in ("ramadan", "raya", "cny"):
            examples.append({"week_end": we.date().isoformat(), "festive": lab, "actual": int(r["y"]),
                             "model": round(float(r["model"])), "same_week_last_year": round(float(r["same_week_last_year"])),
                             "mean_4wk": round(float(r["mean_4wk"]))})
    first = weekly.index[len(weekly) - BACKTEST_WEEKS]
    return {
        "festive_examples_8wk": sorted(examples, key=lambda e: e["week_end"]),
        "period": {"from_week_ending": first.date().isoformat(), "to_week_ending": weekly.index[-1].date().isoformat(),
                   "weeks": BACKTEST_WEEKS, "retrain_every_weeks": RETRAIN_EVERY},
        "national_mape_by_horizon": by_h,
        "national_mape_h1": nat_h1,
        "national_mape_all_horizons": nat_overall,
        "areas_wape_all_horizons": areas,
        "areas_wape_detail": sorted(per_area, key=lambda r: r["area"]),
        "national_mape_by_blood_type": by_type,
        "interval_80": intervals,
    }


# --------------------------------------------------------------------------- outputs

def pulse(daily: pd.DataFrame) -> dict:
    """Last 7 and 28 days vs the series' trailing 365-day daily mean and vs the same days last year."""
    last = daily.index.max()
    out = {}
    for col in daily.columns:
        s = daily[col]
        year = s[last - pd.Timedelta(days=364):]
        base = float(year.mean())
        if base <= 0:
            continue
        rec = {}
        for n in (7, 28):
            cur = s[last - pd.Timedelta(days=n - 1):]
            ly = s[last - pd.Timedelta(days=n - 1 + 364): last - pd.Timedelta(days=364)]
            rec[f"d{n}"] = round(float(cur.mean()), 1)
            rec[f"d{n}_vs_year_pct"] = round((float(cur.mean()) / base - 1) * 100, 1)
            rec[f"d{n}_vs_last_year_pct"] = round((float(cur.mean()) / float(ly.mean()) - 1) * 100, 1) if ly.mean() > 0 else None
        rec["year_daily_mean"] = round(base, 1)
        out.setdefault(col[0], {})[col[1]] = rec
    return out


def forecast(weekly: pd.DataFrame, cal: pd.DataFrame, model, intervals: dict) -> dict:
    n = len(weekly)
    t = n - 1
    rows = make_rows(weekly, cal, origins=[t], need_target=False)
    rows["pred"] = model.predict(rows[FEATURE_COLS]) * rows["level"]
    future = pd.date_range(weekly.index[-1] + pd.Timedelta(weeks=1), periods=HORIZON, freq="W-SUN")
    fut_cal = week_features(future)
    weeks_meta = []
    for i, we in enumerate(future):
        row = fut_cal.loc[we]
        weeks_meta.append({
            "week_start": (we - pd.Timedelta(days=6)).date().isoformat(),
            "week_end": we.date().isoformat(),
            "festive": festive_label(row),
            "holidays": week_labels(we),
        })
    series = {}
    for _, r in rows.iterrows():
        area, btype = weekly.columns[int(r["series"])]
        h = int(r["h"])
        iv = intervals.get(area, {}).get(btype, {"lo": 0.75, "hi": 1.25})
        rec = series.setdefault(area, {}).setdefault(btype, {"level": round(float(r["level"]), 1), "forecast": [None] * HORIZON})
        rec["forecast"][h - 1] = {
            "pred": round(float(r["pred"]), 1),
            "lo": round(float(r["pred"]) * iv["lo"], 1),
            "hi": round(float(r["pred"]) * iv["hi"], 1),
            "vs_usual_pct": round((float(r["pred"]) / float(r["level"]) - 1) * 100, 1),
        }
    return {"weeks": weeks_meta, "series": series}


def history(weekly: pd.DataFrame, cal: pd.DataFrame, weeks: int = 104) -> dict:
    w = weekly.iloc[-weeks:]
    c = cal.reindex(w.index)
    out = {"weeks": [d.date().isoformat() for d in w.index],
           "festive": [festive_label(c.loc[d]) for d in w.index],
           "series": {}}
    for col in w.columns:
        out["series"].setdefault(col[0], {})[col[1]] = [int(v) for v in w[col].to_numpy()]
    return out


def seasonal_profile(weekly: pd.DataFrame, cal: pd.DataFrame) -> list[dict]:
    """Average change in national donations during each festive window, by year (for the 'why' panel)."""
    s = weekly[("Malaysia", "all")]
    c = cal.reindex(s.index)
    out = []
    for key in ["ramadan", "post_raya", "cny", "deepavali", "year_end"]:
        for year in range(2022, int(s.index[-1].year) + 1):
            in_win = (c[key] >= 4) & (s.index.year == year)
            if not in_win.any():
                continue
            first = s.index[in_win][0]
            base = s[first - pd.Timedelta(weeks=9): first - pd.Timedelta(weeks=1)]
            base = base[c.reindex(base.index)[FEATURES].sum(axis=1) == 0]
            if len(base) < 3:
                continue
            out.append({"festive": key, "year": year,
                        "change_pct": round((float(s[in_win].mean()) / float(base.mean()) - 1) * 100, 1)})
    return out


def main() -> None:
    t0 = time.time()
    out_dir = Path(os.environ.get("OUT_DIR", Path(__file__).resolve().parent.parent / "site" / "data"))
    out_dir.mkdir(parents=True, exist_ok=True)
    df = load_daily(os.environ.get("DATA_DIR"))
    daily = to_daily_wide(df)
    weekly = to_weekly(daily)
    cal = week_features(weekly.index.union(pd.date_range(weekly.index[-1] + pd.Timedelta(weeks=1), periods=HORIZON, freq="W-SUN")))
    all_rows = make_rows(weekly, cal)
    print(f"data to {daily.index.max().date()}, {len(weekly)} weeks, {weekly.shape[1]} series, {len(all_rows)} rows")

    bt = backtest(weekly, cal, all_rows)
    summary = summarise_backtest(bt, weekly, cal)
    print("national MAPE h1:", summary["national_mape_h1"])
    print("national MAPE all horizons:", summary["national_mape_all_horizons"])
    print("areas WAPE all horizons:", summary["areas_wape_all_horizons"])

    model = fit(all_rows)
    fc = forecast(weekly, cal, model, summary["interval_80"])

    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
    meta = {
        "data_as_of": daily.index.max().date().isoformat(),
        "last_complete_week_end": weekly.index[-1].date().isoformat(),
        "generated_at": now.isoformat(timespec="minutes"),
        "source": {"name": "Ministry of Health Malaysia (PDN) via data.gov.my", "licence": "CC BY 4.0",
                   "urls": [NATIONAL_URL, STATE_URL]},
        "notes": [
            "Counts cover the 22 main donation sites integrated with BBISv2 (about 80% of donations).",
            "Selangor and W.P. Kuala Lumpur are merged as Klang Valley; Perlis and W.P. Labuan are not in the data.",
            "These are donations, not blood stock or hospital demand.",
        ],
        "model": {"type": "HistGradientBoostingRegressor, direct multi-horizon, trained on weeks since "
                  + TRAIN_FROM.date().isoformat() + " excluding COVID-19 weeks", "horizon_weeks": HORIZON},
        "backtest": summary,
        "seasonal_profile": seasonal_profile(weekly, cal),
    }
    files = {"meta.json": meta, "pulse.json": pulse(daily), "forecast.json": fc, "history.json": history(weekly, cal)}
    for name, obj in files.items():
        (out_dir / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    bt.drop(columns=["series_name"]).to_csv(out_dir.parent.parent / "pipeline" / "backtest_predictions.csv.gz",
                                             index=False, compression="gzip") if os.environ.get("SAVE_BACKTEST") else None
    print(f"wrote {', '.join(files)} to {out_dir} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
