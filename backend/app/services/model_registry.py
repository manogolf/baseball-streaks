# backend/scripts/model_trainer.py
"""
Train and write per-prop models to disk (MODELS_DIR).
- Reads: model_training_props (Supabase)
- Target: outcome ('win'→1, 'loss'→0)
- Features: safe numeric + small categorical
- Heavily weights user_added rows
- Writes: MODELS_DIR/latest/<prop>.joblib and MODELS_DIR/archive/<prop>/<prop>-<ts>.joblib
"""

import io, os, json, time
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

import numpy as np
import pandas as pd
import joblib

from supabase import create_client, Client
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score
from sklearn.utils.validation import check_is_fitted

# ---------- Config ----------
DEFAULT_DAYS_BACK = 365
DEFAULT_ROW_LIMIT = 50_000

PROP_TYPES = [
    "doubles","earned_runs","hits","hits_allowed","hits_runs_rbis","home_runs",
    "outs_recorded","rbis","runs_rbis","runs_scored","singles","stolen_bases",
    "strikeouts_batting","strikeouts_pitching","total_bases","triples","walks",
    "walks_allowed",
]

# Where to write models (local or Render disk)
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "./models_out")).resolve()
LATEST_DIR = MODELS_DIR / "latest"
ARCHIVE_DIR = MODELS_DIR / "archive"

# Numeric features we’d like to use (we’ll keep only those that actually exist & have data)
NUMERIC_COLS = [
    "line","prop_value","rolling_result_avg_7","line_diff",
    "hit_streak","win_streak","is_home","is_pitcher",
]

# Small-cardinality categoricals
CAT_COLS = [
    "time_of_day_bucket",   # e.g., morning/afternoon/night
    "game_day_of_week",     # e.g., Mon/Tue
    # add tiny IDs only if cardinality is small:
    # "team_id", "opponent_team_id",
]

# ---------- Supabase ----------
def _supabase_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or key (SERVICE_ROLE/ANON).")
    return create_client(url, key)

def fetch_training_rows(sb: Client, prop_type: str, days_back: int, limit: int) -> pd.DataFrame:
    since = (datetime.utcnow() - timedelta(days=days_back)).date().isoformat()
    q = (
        sb.table("model_training_props")
        .select("*")
        .eq("prop_type", prop_type)
        .in_("status", ["win","loss"])
        .not_.is_("prop_value", "null")
        .gte("game_date", since)
        .order("game_date", desc=True)
        .limit(limit)
    )
    rows = (q.execute().data or [])
    rows = [r for r in rows if r.get("outcome") in ("win","loss")]  # extra guard
    return pd.DataFrame(rows)

# ---------- Build pipelines with chosen cols ----------
def build_pipeline(num_cols: List[str], cat_cols: List[str]) -> tuple[Pipeline, Pipeline]:
    num_transform = Pipeline([("imputer", SimpleImputer(strategy="median"))])
    cat_transform = Pipeline([
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=True)),
    ])
    pre = ColumnTransformer(
        transformers=[
            ("num", num_transform, num_cols),
            ("cat", cat_transform, cat_cols),
        ],
        remainder="drop",
        sparse_threshold=0.3,
    )

    # Base learners
    lr = LogisticRegression(max_iter=2000, n_jobs=None)
    rf = RandomForestClassifier(
        n_estimators=300,
        max_depth=None,
        n_jobs=-1,
        random_state=42,
    )

    # LR calibration (fallback to plain LR if calibration fails due to tiny data)
    try:
        lr_cal = CalibratedClassifierCV(lr, method="isotonic", cv=3)
        pipe_lr = Pipeline([("pre", pre), ("clf", lr_cal)])
    except Exception:
        pipe_lr = Pipeline([("pre", pre), ("clf", lr)])

    pipe_rf = Pipeline([("pre", pre), ("clf", rf)])
    return pipe_lr, pipe_rf

# ---------- Train one prop ----------
def train_models_for_prop(
    prop_type: str,
    *,
    days_back: int = DEFAULT_DAYS_BACK,
    limit: int = DEFAULT_ROW_LIMIT,
    quiet: bool = True,
) -> Optional[Dict[str, Any]]:
    sb = _supabase_client()
    df = fetch_training_rows(sb, prop_type, days_back, limit)

    if df.empty or "outcome" not in df.columns:
        if not quiet:
            print(f"⏭️  {prop_type}: no training rows.")
        return None

    df = df.copy()
    df["y"] = (df["outcome"] == "win").astype(int)

    # booleans to numeric-ish (if present)
    for b in ("is_home","is_pitcher"):
        if b in df.columns:
            df[b] = df[b].astype(float)

    # Choose only columns that exist; keep numeric that have at least one non-null
    num_used = [c for c in NUMERIC_COLS if c in df.columns and pd.Series(df[c]).notna().any()]
    cat_used = [c for c in CAT_COLS if c in df.columns]

    if not num_used and not cat_used:
        if not quiet:
            print(f"⏭️  {prop_type}: zero usable features; skipping.")
        return None

    pipe_lr, pipe_rf = build_pipeline(num_used, cat_used)

    # Split holdout
    df = df.sample(frac=1.0, random_state=42)
    n_val = max(1, int(len(df) * 0.2))
    train_df, val_df = df.iloc[n_val:], df.iloc[:n_val]

    X_tr = train_df[num_used + cat_used] if (num_used or cat_used) else train_df[[]]
    y_tr = train_df["y"].to_numpy()
    X_v  =  val_df[num_used + cat_used] if (num_used or cat_used) else  val_df[[]]
    y_v  =  val_df["y"].to_numpy()

    # weights (boost user_added heavily)
    w_tr = np.ones(len(train_df), dtype="float64")
    if "prop_source" in train_df.columns:
        w_tr[train_df["prop_source"].values == "user_added"] = 1000.0
    w_v = np.ones(len(val_df), dtype="float64")

    # --- FIT (this is the part your saved models were missing) ---
    pipe_lr.fit(X_tr, y_tr, **({"clf__sample_weight": w_tr} if "clf__sample_weight" in pipe_lr.get_params() else {}))
    pipe_rf.fit(X_tr, y_tr, clf__sample_weight=w_tr)

    # Verify fitted
    for name, m in (("lr", pipe_lr), ("rf", pipe_rf)):
        try:
            check_is_fitted(m)
        except Exception as e:
            raise RuntimeError(f"{prop_type}: model {name} failed to fit: {e}")

    # Validate (may be NaN if y_v single-class)
    def _auc(m):
        try:
            p = m.predict_proba(X_v)[:, 1]
            return float(roc_auc_score(y_v, p, sample_weight=w_v))
        except Exception:
            return None

    auc_lr = _auc(pipe_lr)
    auc_rf = _auc(pipe_rf)

    if not quiet:
        print(f"📈 {prop_type}  AUC — LR: {auc_lr if auc_lr is not None else '—'}  RF: {auc_rf if auc_rf is not None else '—'}")

    # Pick best for convenience
    best_model = pipe_rf if ((auc_rf or -1) >= (auc_lr or -1)) else pipe_lr

    # Payload
    payload = {
        "best": best_model,
        "lr": pipe_lr,
        "rf": pipe_rf,
        "meta": {
            "prop_type": prop_type,
            "trained_at": datetime.utcnow().isoformat(),
            "days_back": days_back,
            "limit": limit,
            "auc_lr": auc_lr,
            "auc_rf": auc_rf,
            "features_num": num_used,
            "features_cat": cat_used,
        },
    }

    # Write latest + archive
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    (LATEST_DIR).mkdir(parents=True, exist_ok=True)
    (ARCHIVE_DIR / prop_type).mkdir(parents=True, exist_ok=True)

    latest_path  = (LATEST_DIR / f"{prop_type}.joblib").resolve()
    archive_path = (ARCHIVE_DIR / prop_type / f"{prop_type}-{ts}.joblib").resolve()

    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    blob = buf.getvalue()

    # atomic writes
    def _atomic_write(path: Path, data: bytes):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)

    _atomic_write(latest_path, blob)
    _atomic_write(archive_path, blob)

    # Update index
    index_path = (LATEST_DIR / "MODEL_INDEX.json").resolve()
    index = {}
    if index_path.exists():
        try:
            index = json.loads(index_path.read_text())
        except Exception:
            index = {}
    index[prop_type] = {
        "prop_type": prop_type,
        "trained_at": datetime.utcnow().isoformat(),
        "file": latest_path.name,
        "auc_lr": auc_lr,
        "auc_rf": auc_rf,
        "rows": int(len(df)),
        "features_num": num_used,
        "features_cat": cat_used,
    }
    index_path.write_text(json.dumps(index, indent=2))

    return {
        "prop_type": prop_type,
        "auc_lr": auc_lr,
        "auc_rf": auc_rf,
        "latest_path": str(latest_path),
        "archive_path": str(archive_path),
        "rows": int(len(df)),
    }
