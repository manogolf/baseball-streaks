# ml/train_batter_props.py
"""
Batter prop trainer (market-agnostic) with time-aware auto-selection of zero process
and robust bagged calibration.

Props: hits, singles, total_bases, runs, hrr
Input CSV: ml/train_batter_<prop>.csv (must contain y_<prop> target)
Excludes from features: IDs, y_over, any line_*, prop_source
Carries through (not used as features): user_added (if present)

Model candidates:
  - ZIP (zero-inflated Poisson): pi(x) via classifier, lambda(x) via Poisson regressor
  - Poisson-only: lambda(x) via Poisson regressor, pi ≡ 0

Auto-select:
  - Forward-chaining K folds on TRAIN window
  - For each fold & line, compute OOF P(over) and Brier
  - Sum Brier across folds (& line weights), choose lower-Brier candidate

Calibration:
  - Build a bag of per-fold calibrators (isotonic by default; Platt optional)
  - Robust aggregation: skip too-narrow iso maps; median across folds
  - Clip final probs to [clip_min, clip_max]

Saves:
  - ml/models/batter/<prop>/: zip_lambda.joblib (+ zip_zero.joblib if ZIP chosen)
  - calibrators_<prop>_v1.json  (type, per-line bags, clip bounds, chosen mode)
  - features_<prop>_v1.json
  - ml/pred_<prop>_test.csv (IDs, user_added, y_true, raw components, per-line probs)

Usage example:
  python ml/train_batter_props.py \
    --prop singles --csv ml/train_batter_singles.csv \
    --lines 0.5 1.5 --folds 5 --calibration isotonic --zero-select auto
"""

from __future__ import annotations
import argparse, json, math, os
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from joblib import dump
from pandas.api.types import is_numeric_dtype
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier as HGBC
from sklearn.ensemble import HistGradientBoostingRegressor as HGBR
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, average_precision_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

# ----------------------
# Helpers
# ----------------------
def make_time_splits(dates: pd.Series, k: int) -> List[Tuple[pd.Timestamp, pd.Timestamp]]:
    d = pd.to_datetime(dates).sort_values().unique()
    if len(d) < k:
        k = max(1, len(d))
    edges = np.linspace(0, len(d), k + 1, dtype=int)
    out = []
    for i in range(k):
        lo_idx, hi_idx = edges[i], edges[i + 1]
        if hi_idx - lo_idx <= 0:
            continue
        start = pd.Timestamp(d[lo_idx])
        end = pd.Timestamp(d[hi_idx]) if hi_idx < len(d) else pd.Timestamp(d[-1]) + pd.Timedelta(days=1)
        out.append((start, end))
    return out

def poisson_tail_over(line: float, pi: np.ndarray, lam: np.ndarray) -> np.ndarray:
    """P(Y > line) under ZIP. For Poisson-only, pass pi=zeros."""
    t = int(math.floor(line)) + 1
    lam = np.clip(lam, 1e-6, 1e6)
    e = np.exp(-lam)
    p0 = pi + (1.0 - pi) * e
    tail = np.ones_like(lam)
    tail -= p0
    pk = (1.0 - pi) * e * lam  # k=1
    for k in range(1, t):
        if k > 1:
            pk = pk * lam / k
        tail -= pk
    return np.clip(tail, 0.0, 1.0)

def eval_line(name: str, y_true: np.ndarray, p_over: np.ndarray, line: float) -> None:
    y_bin = (y_true > line).astype(int)
    brier = float(np.mean((p_over - y_bin) ** 2))
    auc = float(roc_auc_score(y_bin, p_over)) if len(np.unique(y_bin)) > 1 else float("nan")
    ap  = float(average_precision_score(y_bin, p_over)) if len(np.unique(y_bin)) > 1 else float("nan")
    print(f"{name} Line {line}: Brier={brier:.4f}  ROC-AUC={auc:.3f}  PR-AUC={ap:.3f}")
    bins = np.linspace(0, 1, 11)
    print("  bin       n    p̂    p_obs")
    for i in range(10):
        lo, hi = bins[i], bins[i + 1]
        m = (p_over >= lo) & (p_over < hi) if i < 9 else (p_over >= lo) & (p_over <= hi)
        if m.sum() == 0: 
            continue
        print(f"  [{lo:.1f},{hi:.1f}] {int(m.sum()):4d}  {float(p_over[m].mean()):.3f}  {float(y_bin[m].mean()):.3f}")

def fit_zip_pipes(X_train, y_train, cat_cols, num_cols):
    pre = ColumnTransformer(
        transformers=[
            ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), cat_cols),
            ("num", "passthrough", num_cols),
        ],
        remainder="drop",
    )
    clf = HGBC(
        loss="log_loss",
        learning_rate=0.05,
        max_depth=None,
        max_leaf_nodes=31,
        min_samples_leaf=20,
        l2_regularization=0.0,
        early_stopping=False,
        random_state=42,
    )
    pipe_zero = Pipeline([("pre", pre), ("clf", clf)])
    pipe_zero.fit(X_train, (y_train == 0).astype(int))

    reg = HGBR(
        loss="poisson",
        learning_rate=0.05,
        max_depth=None,
        max_leaf_nodes=31,
        min_samples_leaf=20,
        l2_regularization=0.0,
        early_stopping=False,
        random_state=42,
    )
    pipe_lam = Pipeline([("pre", pre), ("hgb", reg)])
    pipe_lam.fit(X_train, y_train.astype(float))
    return pipe_zero, pipe_lam

def fit_poi_pipe(X_train, y_train, cat_cols, num_cols):
    pre = ColumnTransformer(
        transformers=[
            ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), cat_cols),
            ("num", "passthrough", num_cols),
        ],
        remainder="drop",
    )
    reg = HGBR(
        loss="poisson",
        learning_rate=0.05,
        max_depth=None,
        max_leaf_nodes=31,
        min_samples_leaf=20,
        l2_regularization=0.0,
        early_stopping=False,
        random_state=42,
    )
    pipe_lam = Pipeline([("pre", pre), ("hgb", reg)])
    pipe_lam.fit(X_train, y_train.astype(float))
    return pipe_lam

def apply_calib_bag(p_raw: np.ndarray, bag: List[Dict], clip_min=0.02, clip_max=0.98) -> np.ndarray:
    """Average predictions from calibrator dicts; robust to bad folds."""
    if not bag:
        return np.clip(p_raw, clip_min, clip_max)
    preds = []
    for cal in bag:
        t = cal.get("type", "identity")
        if t == "isotonic":
            x = np.asarray(cal["x"], dtype=float)
            y = np.asarray(cal["y"], dtype=float)
            # guard: ignore folds whose map barely covers any range
            if x.size < 2 or (x[-1] - x[0]) < 0.15:
                preds.append(p_raw)
            else:
                preds.append(np.interp(p_raw, x, y, left=y[0], right=y[-1]))
        elif t == "platt":
            z = cal["coef"] * p_raw + cal["intercept"]
            preds.append(1.0 / (1.0 + np.exp(-z)))
        else:
            preds.append(p_raw)
    p = np.median(np.vstack(preds), axis=0)  # robust aggregator
    return np.clip(p, clip_min, clip_max)

def fit_platt_calibrator(p_over_raw: np.ndarray, y_bin: np.ndarray) -> Dict:
    lr = LogisticRegression(C=3.0, solver="liblinear", max_iter=1000)
    lr.fit(p_over_raw.reshape(-1, 1), y_bin.astype(int))
    return {"type": "platt", "coef": float(lr.coef_[0, 0]), "intercept": float(lr.intercept_[0])}

def brier(y_bin: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((p - y_bin) ** 2))

# ----------------------
# Main
# ----------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prop", required=True, help="hits|singles|total_bases|runs|hrr")
    ap.add_argument("--csv", required=True, help="path to ml/train_batter_<prop>.csv")
    ap.add_argument("--lines", nargs="+", type=float, default=[0.5, 1.5, 2.5])
    ap.add_argument("--line-weights", nargs="*", type=float, default=None, help="optional weights per line (same length as --lines)")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--val-days", type=int, default=28)
    ap.add_argument("--test-days", type=int, default=28)
    ap.add_argument("--lookback-days", type=int, default=int(os.getenv("LOOKBACK_DAYS", "540")))
    ap.add_argument("--clip-min", type=float, default=0.02)
    ap.add_argument("--clip-max", type=float, default=0.98)
    ap.add_argument("--calibration", choices=["isotonic", "platt"], default="isotonic")
    ap.add_argument("--zero-select", choices=["auto", "zip", "poisson"], default="auto")
    args = ap.parse_args()

    TARGET = f"y_{args.prop}"
    ID_COLS = ["game_id", "player_id", "game_date"]
    DROP_IF_PRESENT = {"y_over"} | {c for c in ["line_hits","line_singles","line_total_bases","line_runs","line_hrr"] if c != f"line_{args.prop}"}

    if args.line_weights is not None and len(args.line_weights) != len(args.lines):
        raise ValueError("--line-weights must match --lines length")

    # ---- load
    df = pd.read_csv(args.csv)
    if "game_date" not in df.columns:
        raise ValueError("CSV must include game_date")
    df["game_date"] = pd.to_datetime(df["game_date"])
    df = df.sort_values("game_date").reset_index(drop=True)

    # ---- lookback window
    max_date = df["game_date"].max()
    min_keep = max_date - pd.Timedelta(days=args.lookback_days - 1)
    df = df[df["game_date"] >= min_keep].copy()

    # ---- coerce numerics (avoid raising for now)
    for c in df.columns:
        if c not in ID_COLS + [TARGET]:
            # keep 'ignore' for compatibility; we fill NaNs later
            df[c] = pd.to_numeric(df[c], errors="ignore")

            # --- BvP presence flag (so missing ≠ zero) ---
    BVP_COLS = [
        "bvp_pa_prior","bvp_ab_prior","bvp_hits_prior","bvp_tb_prior",
        "bvp_hr_prior","bvp_bb_prior","bvp_so_prior",
        "bvp_avg_prior_sm","bvp_tb_per_ab_prior_sm","bvp_bb_rate_prior_sm","bvp_so_rate_prior_sm",
    ]
    bvp_present = [c for c in BVP_COLS if c in df.columns]

    if bvp_present:
        if "bvp_pa_prior" in df.columns:
            df["bvp_has_history"] = df["bvp_pa_prior"].notna().astype(int)
        else:
            # fallback: any BvP field present => has history
            df["bvp_has_history"] = (~df[bvp_present].isna().all(axis=1)).astype(int)
    else:
        # column exists so downstream code is stable, but it will be all zeros
        df["bvp_has_history"] = 0


    # ---- features
    if TARGET not in df.columns:
        raise ValueError(f"CSV must include {TARGET}")
    y = df[TARGET].astype(float).values
    ids = df[ID_COLS].copy()
    if "user_added" in df.columns:
        ids["user_added"] = df["user_added"]

    feature_cols = [c for c in df.columns if c not in ID_COLS + [TARGET] and c not in DROP_IF_PRESENT and not c.startswith("line_") and c not in {"prop_source"}]
    X = df[feature_cols].copy()

    num_cols = [c for c in X.columns if is_numeric_dtype(X[c])]
    cat_cols = [c for c in X.columns if c not in num_cols]

    for c in num_cols: X[c] = X[c].fillna(0.0)
    for c in cat_cols: X[c] = X[c].fillna("UNK")

    # ---- time-based split
    test_start = max_date - pd.Timedelta(days=args.test_days - 1)
    val_start  = test_start - pd.Timedelta(days=args.val_days)
    saved_min = df.loc[df["game_date"] < test_start, "game_date"].min()
    saved_max = test_start - pd.Timedelta(days=1)
    print(f"Saved model trained on: {saved_min.date()} → {saved_max.date()}")
    print(f"  train < {val_start.date()}  |  val [{val_start.date()}, {test_start.date()})  |  test ≥ {test_start.date()}")

    train_m = df["game_date"] < val_start
    val_m   = (df["game_date"] >= val_start) & (df["game_date"] < test_start)
    test_m  = df["game_date"] >= test_start

    X_train, y_train = X[train_m], y[train_m]
    X_val,   y_val   = X[val_m],   y[val_m]   # not used in selection; kept for reference
    X_test,  y_test  = X[test_m],  y[test_m]

    print("Shapes:", X_train.shape, X_val.shape, X_test.shape)

    # ----------------------
    # Auto-select zero process on TRAIN via OOF Brier across lines
    # ----------------------
    chosen = args.zero_select
    lines = list(args.lines)
    wts = np.array(args.line_weights if args.line_weights is not None else [1.0]*len(lines), dtype=float)

    folds = make_time_splits(df.loc[train_m, "game_date"], k=args.folds)
    if chosen == "auto":
        brier_sum_zip = 0.0
        brier_sum_poi = 0.0

        for (fold_start, fold_end) in folds:
            fold_mask = train_m & (df["game_date"] >= fold_start) & (df["game_date"] < fold_end)
            pre_mask  = train_m & (df["game_date"] < fold_start)
            if pre_mask.sum() < 100 or fold_mask.sum() == 0:
                continue

            # ZIP candidate
            pipe_zero_zip, pipe_lam_zip = fit_zip_pipes(X[pre_mask], pd.Series(y[pre_mask]), cat_cols, num_cols)
            pi_zip  = pipe_zero_zip.predict_proba(X[fold_mask])[:, 1]
            lam_zip = np.clip(pipe_lam_zip.predict(X[fold_mask]), 1e-6, 1e6)

            # Poisson-only candidate
            pipe_lam_poi = fit_poi_pipe(X[pre_mask], pd.Series(y[pre_mask]), cat_cols, num_cols)
            pi_poi  = np.zeros(X[fold_mask].shape[0], dtype=float)
            lam_poi = np.clip(pipe_lam_poi.predict(X[fold_mask]), 1e-6, 1e6)

            for j, L in enumerate(lines):
                y_bin = (y[fold_mask] > L).astype(int)
                p_zip = poisson_tail_over(L, pi_zip, lam_zip)
                p_poi = poisson_tail_over(L, pi_poi, lam_poi)
                brier_sum_zip += wts[j] * brier(y_bin, p_zip)
                brier_sum_poi += wts[j] * brier(y_bin, p_poi)

        chosen = "zip" if brier_sum_zip < brier_sum_poi else "poisson"
        print(f"Zero-process selection on TRAIN OOF: ZIP={brier_sum_zip:.6f} vs POI={brier_sum_poi:.6f} ⇒ chosen={chosen}")
    else:
        print(f"Zero-process forced via flag: chosen={chosen}")

    # ----------------------
    # Build bagged calibrators for the chosen candidate (TRAIN only)
    # ----------------------
    cal_bag: Dict[str, List[Dict]] = {str(L).replace(".","_"): [] for L in lines}
    for (fold_start, fold_end) in folds:
        fold_mask = train_m & (df["game_date"] >= fold_start) & (df["game_date"] < fold_end)
        pre_mask  = train_m & (df["game_date"] < fold_start)
        if pre_mask.sum() < 100 or fold_mask.sum() == 0:
            continue

        if chosen == "zip":
            pipe_zero, pipe_lam = fit_zip_pipes(X[pre_mask], pd.Series(y[pre_mask]), cat_cols, num_cols)
            pi_f  = pipe_zero.predict_proba(X[fold_mask])[:, 1]
            lam_f = np.clip(pipe_lam.predict(X[fold_mask]), 1e-6, 1e6)
        else:
            pipe_lam = fit_poi_pipe(X[pre_mask], pd.Series(y[pre_mask]), cat_cols, num_cols)
            pi_f  = np.zeros(X[fold_mask].shape[0], dtype=float)
            lam_f = np.clip(pipe_lam.predict(X[fold_mask]), 1e-6, 1e6)

        for L in lines:
            p_over_raw = poisson_tail_over(L, pi_f, lam_f)
            y_bin = (y[fold_mask] > L).astype(int)

            if args.calibration == "platt":
                cal = fit_platt_calibrator(p_over_raw, y_bin)
            else:
                iso = IsotonicRegression(out_of_bounds="clip")
                iso.fit(p_over_raw, y_bin)
                cal = {"type": "isotonic",
                       "x": iso.X_thresholds_.tolist(),
                       "y": iso.y_thresholds_.tolist()}
            cal.update({
                "fold_start": str(fold_start.date()),
                "fold_end": str((fold_end - pd.Timedelta(days=1)).date()),
            })
            cal_bag[str(L).replace(".","_")].append(cal)

    # ----------------------
    # Final fit on TRAIN for chosen candidate, evaluate on TEST
    # ----------------------
    if chosen == "zip":
        pipe_zero, pipe_lam = fit_zip_pipes(X_train, pd.Series(y_train), cat_cols, num_cols)
    else:
        pipe_zero = None
        pipe_lam  = fit_poi_pipe(X_train, pd.Series(y_train), cat_cols, num_cols)

    ids_test = ids.loc[test_m].copy()
    yhat_lam = np.clip(pipe_lam.predict(X_test), 1e-6, 1e6)
    yhat_pi  = pipe_zero.predict_proba(X_test)[:, 1] if pipe_zero is not None else np.zeros(X_test.shape[0], dtype=float)

    out = ids_test.copy()
    out["y_true"] = y_test
    out["p_zero_raw"] = yhat_pi
    out["lambda_raw"] = yhat_lam

    for L in lines:
        raw = poisson_tail_over(L, yhat_pi, yhat_lam)
        bag = cal_bag.get(str(L).replace(".","_"), [])
        cal = apply_calib_bag(raw, bag, clip_min=args.clip_min, clip_max=args.clip_max)
        out[f"p_over_{str(L).replace('.','_')}"] = cal

    for L in lines:
        eval_line("test", y_test, out[f"p_over_{str(L).replace('.','_')}"].values, L)

    # persist
    models_dir = Path("ml/models") / "batter" / args.prop
    models_dir.mkdir(parents=True, exist_ok=True)
    if pipe_zero is not None:
        dump(pipe_zero, models_dir / "zip_zero.joblib")
    dump(pipe_lam,  models_dir / "zip_lambda.joblib")
    with open(models_dir / f"calibrators_{args.prop}_v1.json", "w") as f:
        json.dump({
            "prop": args.prop,
            "lines": {k: v for k, v in cal_bag.items()},
            "clip": {"min": args.clip_min, "max": args.clip_max},
            "folds": args.folds,
            "calibration": args.calibration,
            "chosen_zero_process": chosen,
        }, f, indent=2)
    with open(models_dir / f"features_{args.prop}_v1.json", "w") as f:
        json.dump(list(X.columns), f)

    out_path = Path("ml") / f"pred_{args.prop}_test.csv"
    out.to_csv(out_path, index=False)
    print(f"\nChosen zero process: {chosen}")
    print(f"Saved models to {models_dir}")
    print(f"Wrote test predictions to {out_path}")

if __name__ == "__main__":
    main()
