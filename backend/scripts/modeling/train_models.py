# backend/scripts/modeling/train_models.py
from __future__ import annotations

import os
import sys
import json
import math
import time
import argparse
import datetime as dt
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd

# sklearn 1.6.x
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression

# Optional DB client used elsewhere in your repo
try:
    from backend.scripts.shared.supabase_utils import supabase
except Exception:
    supabase = None


# ---------------------------
# Small helpers
# ---------------------------

EXCLUDE_KEYS = {
    "player_id", "team_id", "game_id", "game_date",
    "prop_type", "over_under", "prop_value",
    "prop_source", "created_at", "updated_at", "ingested_at",
    # loader bookkeeping that might appear
    "_rowid", "_ts", "_source"
}


def now_iso() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def coerce_binary(s: pd.Series) -> pd.Series:
    """Attempt to coerce a column to {0,1} ints."""
    if s.dtype == bool:
        return s.astype(int)
    try:
        x = pd.to_numeric(s, errors="coerce")
        # Treat anything >=0.5 as 1 for safety if not already {0,1}
        x = (x >= 0.5).astype(int)
        return x
    except Exception:
        return pd.Series([np.nan] * len(s))


def pick_label(df: pd.DataFrame) -> Tuple[pd.Series, str]:
    """
    Try to find/derive the training label (OVER=1 / UNDER=0).
    Priority order of column names; if none found, try actual vs line.
    """
    candidate_names = [
        "label_over",
        "is_over",
        "over",
        "target",
        "y",
        "result_over",
        "actual_over",
    ]
    for name in candidate_names:
        if name in df.columns:
            y = coerce_binary(df[name])
            if y.notna().any():
                return y, name

    # Derive from actual vs line/prop_value
    # Look for an "actual" column (e.g., actual_value, actual, stat_actual, etc.)
    actual_cols = [c for c in df.columns if c.lower().startswith("actual")]
    line_cols = [c for c in ("line", "prop_value") if c in df.columns]

    if actual_cols and line_cols:
        # choose first plausible actual col
        a = pd.to_numeric(df[actual_cols[0]], errors="coerce")
        l = pd.to_numeric(df[line_cols[0]], errors="coerce")
        y = (a > l).astype(int)
        return y, f"{actual_cols[0]} > {line_cols[0]}"

    raise RuntimeError(
        "Could not determine training label. "
        "Provide a boolean column (e.g., label_over/is_over) or actual+line."
    )


def add_streak_type(df: pd.DataFrame) -> pd.DataFrame:
    """Ensure a single categorical 'streak_type' exists from hot/cold flags."""
    if "streak_type" in df.columns:
        return df
    hot = df.get("streak_type_hot")
    cold = df.get("streak_type_cold")
    if hot is None and cold is None:
        df = df.copy()
        df["streak_type"] = "none"
        return df

    def label_row(h, c):
        try:
            h1 = (float(h) >= 0.5) if h is not None and not pd.isna(h) else False
        except Exception:
            h1 = bool(h)
        try:
            c1 = (float(c) >= 0.5) if c is not None and not pd.isna(c) else False
        except Exception:
            c1 = bool(c)
        if h1 and not c1:
            return "hot"
        if c1 and not h1:
            return "cold"
        return "none"

    df = df.copy()
    df["streak_type"] = [label_row(h, c) for h, c in zip(hot if hot is not None else [], cold if cold is not None else [])] \
        if (hot is not None or cold is not None) else "none"
    return df


def build_feature_matrix(df: pd.DataFrame) -> Tuple[pd.DataFrame, List[str]]:
    """
    Construct model input columns:
      - keep base columns (excluding IDs/provenance)
      - add isna__<base> indicators
      - ensure single categorical 'streak_type'
    Returns (X, input_columns)
    """
    df = add_streak_type(df)

    base_cols = [c for c in df.columns if c not in EXCLUDE_KEYS]
    # Move categorical to the front (helps readability / determinism)
    cols: List[str] = []

    # Ensure 'streak_type' present
    if "streak_type" in base_cols:
        cols.append("streak_type")
        base_cols.remove("streak_type")

    # Rest of base cols (deterministic order)
    for c in sorted(base_cols):
        cols.append(c)

    # isna__ indicators for each base col (including streak_type? no)
    for c in sorted([c for c in cols if c != "streak_type"]):
        cols.append(f"isna__{c}")

    # Build matrix
    X = pd.DataFrame(index=df.index)
    # streak_type: keep string
    if "streak_type" in cols:
        X["streak_type"] = df["streak_type"].astype(str)
    # numeric features
    for c in cols:
        if c == "streak_type":
            continue
        if c.startswith("isna__"):
            base = c.split("__", 1)[1]
            v = df[base] if base in df.columns else None
            X[c] = np.where(v.isna() if v is not None else True, 1.0, 0.0)
        else:
            X[c] = pd.to_numeric(df.get(c, 0.0), errors="coerce").fillna(0.0)

    return X, cols


def eval_slices(y_true: np.ndarray, p_over: np.ndarray, prop_type: str, tag: str = "val") -> dict:
    """
    Direction accuracy and calibration by confidence bins.
    y_true: 1 for OVER, 0 for UNDER. p_over: P(OVER).
    """
    y_true = np.asarray(y_true).astype(int)
    p_over = np.asarray(p_over).astype(float)
    pick_over = (p_over >= 0.5).astype(int)
    conf = np.maximum(p_over, 1.0 - p_over)

    acc = float((pick_over == y_true).mean()) if len(y_true) else float("nan")

    bins = np.linspace(0.5, 1.0, 6)  # [0.5,0.6), ..., [0.9,1.0]
    which = np.digitize(conf, bins, right=False)

    rows = []
    for b in range(1, len(bins) + 1):
        mask = which == b
        n = int(mask.sum())
        left = float(bins[b - 1] if b - 1 < len(bins) else 1.0)
        right = float(bins[b] if b < len(bins) else 1.0)
        if n == 0:
            rows.append({
                "bin_left": round(left, 3),
                "bin_right": round(right, 3),
                "n": 0, "coverage": 0.0, "acc": None,
                "avg_conf": None, "avg_p_over": None
            })
            continue
        acc_b = float((pick_over[mask] == y_true[mask]).mean())
        rows.append({
            "bin_left": round(left, 3),
            "bin_right": round(right, 3),
            "n": n,
            "coverage": round(n / len(y_true), 4),
            "acc": round(acc_b, 4),
            "avg_conf": round(float(conf[mask].mean()), 4),
            "avg_p_over": round(float(p_over[mask].mean()), 4),
        })

    return {
        "prop_type": prop_type,
        "split": tag,
        "n": int(len(y_true)),
        "overall_acc": None if math.isnan(acc) else round(acc, 4),
        "by_confidence": rows
    }


# ---------------------------
# Data loading
# ---------------------------

def _fetch_supabase_all(table: str, select: str = "*", where: Dict[str, Any] | None = None, page_size: int = 1000) -> List[Dict[str, Any]]:
    if supabase is None:
        raise RuntimeError("Supabase client not available; set SUPABASE vars or provide --csv")
    q = supabase.table(table).select(select)
    if where:
        for k, v in where.items():
            q = q.eq(k, v)
    out: List[Dict[str, Any]] = []
    start = 0
    while True:
        resp = q.range(start, start + page_size - 1).execute()
        rows = getattr(resp, "data", None) or []
        out.extend(rows)
        if len(rows) < page_size:
            break
        start += page_size
    return out


def load_training_frame(prop: str, limit: Optional[int] = None) -> pd.DataFrame:
    """
    Try sources in order:
      1) training_features_{prop}_enriched
      2) training_features_for_model_v2 (filtered prop_type)
      3) training_features_store (filtered prop_type)
    """
    sources = [
        (f"training_features_{prop}_enriched", {}),
        ("training_features_for_model_v2", {"prop_type": prop}),
        ("training_features_store", {"prop_type": prop}),
    ]
    errors = []
    for table, wh in sources:
        try:
            rows = _fetch_supabase_all(table, "*", wh)
            if not rows:
                errors.append(f"{table}: 0 rows")
                continue
            df = pd.DataFrame(rows)
            if limit and len(df) > limit:
                df = df.sample(n=limit, random_state=42)
            df = df.reset_index(drop=True)
            print(f"[load] {table} rows={len(df)} cols={len(df.columns)}")
            return df
        except Exception as e:
            errors.append(f"{table}: {e}")
            continue
    raise RuntimeError("No training data found for prop="
                       f"{prop}. Tried: " + " | ".join(errors))


# ---------------------------
# Training
# ---------------------------

def build_pipelines(numeric_cols: List[str], cat_cols: List[str]) -> Tuple[Pipeline, Pipeline]:
    """
    Two pipelines with identical preprocessors:
      - LR: impute->scale->OHE for categorical
      - RF: impute->(no scale)->OHE for categorical
    """
    # OneHotEncoder signature varies across sklearn versions
    try:
        ohe = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    except TypeError:
        # older sklearn
        ohe = OneHotEncoder(handle_unknown="ignore", sparse=False)

    numeric_imputer = Pipeline(steps=[
        ("imputer", SimpleImputer(strategy="constant", fill_value=0.0)),
    ])
    numeric_imputer_scaled = Pipeline(steps=[
        ("imputer", SimpleImputer(strategy="constant", fill_value=0.0)),
        ("scaler", StandardScaler()),
    ])
    categorical = Pipeline(steps=[
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("onehot", ohe),
    ])

    pre_lr = ColumnTransformer(
        transformers=[
            ("num", numeric_imputer_scaled, numeric_cols),
            ("cat", categorical, cat_cols),
        ],
        remainder="drop",
        verbose_feature_names_out=False,
    )
    pre_rf = ColumnTransformer(
        transformers=[
            ("num", numeric_imputer, numeric_cols),
            ("cat", categorical, cat_cols),
        ],
        remainder="drop",
        verbose_feature_names_out=False,
    )

    lr = Pipeline(steps=[
        ("pre", pre_lr),
        ("clf", LogisticRegression(max_iter=1000, n_jobs=None, class_weight="balanced")),
    ])
    rf = Pipeline(steps=[
        ("pre", pre_rf),
        ("clf", RandomForestClassifier(
            n_estimators=400, max_depth=None, n_jobs=-1, class_weight=None,
            min_samples_split=2, min_samples_leaf=1, random_state=42
        )),
    ])
    return lr, rf


def train_one(prop: str, outdir: Path, limit: Optional[int] = None, test_size: float = 0.2, seed: int = 42) -> Path:
    print(f"\n=== Training {prop} ===")
    df = load_training_frame(prop, limit=limit)

    # label
    y, y_source = pick_label(df)
    df = df.loc[y.index]
    y = y.astype(int)

    # features
    X_raw = df.drop(columns=[c for c in df.columns if c == y_source], errors="ignore")
    X, input_cols = build_feature_matrix(X_raw)

    # split
    X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=test_size, random_state=seed, stratify=y)

    # pipelines
    cat_cols = ["streak_type"] if "streak_type" in X.columns else []
    numeric_cols = [c for c in X.columns if c not in cat_cols]

    pipe_lr, pipe_rf = build_pipelines(numeric_cols, cat_cols)

    # fit
    pipe_lr.fit(X_train, y_train)
    pipe_rf.fit(X_train, y_train)

    # evaluate
    def proba_over(pipe: Pipeline, XX: pd.DataFrame) -> np.ndarray:
        if hasattr(pipe, "predict_proba"):
            return pipe.predict_proba(XX)[:, 1]
        # fallback for odd estimators
        pred = pipe.predict(XX)
        pred = np.asarray(pred).reshape(-1)
        # push logits/scores through sigmoid if they look continuous
        return (pred - pred.min()) / (pred.max() - pred.min() + 1e-9)

    p_lr = proba_over(pipe_lr, X_val)
    p_rf = proba_over(pipe_rf, X_val)

    auc_lr = float(roc_auc_score(y_val, p_lr))
    auc_rf = float(roc_auc_score(y_val, p_rf))

    # choose best
    best_key = "lr" if auc_lr >= auc_rf else "rf"
    best_pipe = pipe_lr if best_key == "lr" else pipe_rf

    # slices
    slices_lr = eval_slices(y_val, p_lr, prop, tag="val_lr")
    slices_rf = eval_slices(y_val, p_rf, prop, tag="val_rf")

    # pack artifact
    meta: Dict[str, Any] = {
        "prop_type": prop,
        "trained_at": now_iso(),
        "rows": int(len(df)),
        "y_source": y_source,
        "auc_lr": round(auc_lr, 6),
        "auc_rf": round(auc_rf, 6),
        "algo_best": best_key,
        # predictor will read this first:
        "input_columns": list(X.columns),  # <- VERY IMPORTANT
        # keep alternates for backward-compat:
        "expected_input_columns": list(X.columns),
        "features_in": list(X.columns),
        "eval_slices": {"lr": slices_lr, "rf": slices_rf},
    }

    artifact = {
        "best": best_pipe,
        "lr": pipe_lr,
        "rf": pipe_rf,
        "meta": meta,
    }

    outdir.mkdir(parents=True, exist_ok=True)
    out_path = outdir / f"{prop}.joblib"
    joblib.dump(artifact, out_path)
    print(f"[write] {out_path} (best={best_key}, auc_lr={auc_lr:.3f}, auc_rf={auc_rf:.3f})")
    return out_path


# ---------------------------
# CLI
# ---------------------------

ALL_PROPS = [
    "doubles",
    "earned_runs",
    "hits",
    "hits_allowed",
    "hits_runs_rbis",
    "home_runs",
    "outs_recorded",
    "rbis",
    "runs_rbis",
    "runs_scored",
    "singles",
    "stolen_bases",
    "strikeouts_batting",
    "strikeouts_pitching",
    "total_bases",
    "triples",
    "walks",
    "walks_allowed",
]


def main():
    p = argparse.ArgumentParser(description="Train LR+RF models and write artifacts with meta.input_columns.")
    p.add_argument("--prop", action="append", help="Prop type to train (repeatable). If omitted, trains all.")
    p.add_argument("--outdir", default="/var/data/models/latest", help="Directory for joblib artifacts.")
    p.add_argument("--limit", type=int, default=None, help="Sample size cap per prop (for quick runs).")
    p.add_argument("--test-size", type=float, default=0.2, help="Validation split fraction.")
    p.add_argument("--seed", type=int, default=42, help="Random seed for splits.")
    args = p.parse_args()

    props = args.prop if args.prop else ALL_PROPS

    outdir = Path(args.outdir)
    successes, failures = [], []
    for prop in props:
        try:
            path = train_one(prop, outdir, limit=args.limit, test_size=args.test_size, seed=args.seed)
            successes.append((prop, str(path)))
        except Exception as e:
            print(f"[ERR] {prop}: {e}", file=sys.stderr, flush=True)
            failures.append((prop, str(e)))

    print("\n=== Summary ===")
    for prop, path in successes:
        print(f" OK  {prop} -> {path}")
    for prop, msg in failures:
        print(f" FAIL {prop}: {msg}")

    # Non-zero exit if any failures
    if failures:
        sys.exit(2)


if __name__ == "__main__":
    main()
