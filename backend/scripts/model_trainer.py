# backend/scripts/model_trainer.py
"""
Train and save per-prop models (LogReg + RandomForest) to the local filesystem.

- Reads from: model_training_props (via Supabase API)
- Target: outcome ('win'→1, 'loss'→0)
- Features: numeric cols w/ sensible defaults; safe one-hots for small categoricals
- Heavily weights user-added rows (prop_source = 'user_added')
- Writes models to: /var/data/models/{latest,archive} (configurable via MODELS_DIR)

Env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY  (recommended) or SUPABASE_ANON_KEY
  MODELS_DIR (optional, defaults to /var/data/models)
"""

import os, io, json
import numpy as np
import pandas as pd
import joblib

from supabase import create_client, Client
from datetime import datetime, timedelta
from pathlib import Path

from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score

# load .env for Python
from pathlib import Path
try:
    from dotenv import load_dotenv
    for p in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if p.exists():
            load_dotenv(p, override=False)
except Exception:
    pass  # keep going if python-dotenv isn't installed


# --------- Config ---------
DEFAULT_DAYS_BACK = 365   # reduce if you want faster runs
DEFAULT_ROW_LIMIT = 50_000

PROP_TYPES = [
    "doubles","earned_runs","hits","hits_allowed","hits_runs_rbis","home_runs",
    "outs_recorded","rbis","runs_rbis","runs_scored","singles","stolen_bases",
    "strikeouts_batting","strikeouts_pitching","total_bases","triples","walks",
    "walks_allowed",
]

# Local model dirs (Render defaults)
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/var/data/models"))
LATEST_DIR = MODELS_DIR / "latest"
ARCHIVE_DIR = MODELS_DIR / "archive"

def _atomic_write_bytes(path: Path, blob: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.write(blob)
    os.replace(tmp, path)

# Numeric features we expect to exist in model_training_props (guarded w/ fillna)
NUMERIC_COLS = [
    "line","prop_value","rolling_result_avg_7","line_diff",
    "hit_streak","win_streak",
    "is_home","is_pitcher",
]

# Categorical features (kept small to avoid huge one-hot explosions)
BASE_CAT_COLS = [
    "time_of_day_bucket",   # e.g. morning/afternoon/night
    "game_day_of_week",     # e.g. Mon/Tue
]

# Optional small-cardinality IDs (enable only if cardinality is reasonable)
OPTIONAL_SMALL_CATS = [
    # "team_id", "opponent_team_id",
]

CAT_COLS = BASE_CAT_COLS + OPTIONAL_SMALL_CATS

# sklearn 1.2+ uses sparse_output; older versions use sparse
try:
    _ = OneHotEncoder(sparse_output=True, handle_unknown="ignore")
    _ONEHOT_KW = dict(sparse_output=True)
except TypeError:
    _ONEHOT_KW = dict(sparse=True)

def _supabase_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
    )
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or key (SERVICE_ROLE/ANON).")
    return create_client(url, key)

def fetch_training_rows(sb: Client, prop_type: str, days_back: int, limit: int):
    since_date = (datetime.utcnow() - timedelta(days=days_back)).date().isoformat()

    q = (
        sb.table("model_training_props")
        .select("*")
        .eq("prop_type", prop_type)
        # .in_("status", ["win", "loss"])          # ← REMOVE this
        .not_.is_("line", "null")
        .not_.is_("prop_value", "null")
        .gte("game_date", since_date)
        .order("game_date", desc=True)
        .limit(limit)
    )

    resp = q.execute()
    rows = resp.data or []
    # Keep only fully graded rows:
    rows = [r for r in rows if r.get("outcome") in ("win", "loss")]
    return pd.DataFrame(rows)

def _prep_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    df = df.copy()

    # target
    df["y"] = (df["outcome"] == "win").astype(int)

    # coerce booleans/flags to numeric
    for bcol in ("is_home","is_pitcher"):
        if bcol in df.columns:
            df[bcol] = pd.to_numeric(df[bcol], errors="coerce")

    # ensure numeric cols exist
    for col in NUMERIC_COLS:
        if col not in df.columns:
            df[col] = np.nan

    # ensure categoricals exist as strings
    for col in CAT_COLS:
        if col not in df.columns:
            df[col] = None
        df[col] = df[col].astype("string")

    # sample weights: user_added gets big boost
    w = np.ones(len(df), dtype="float64")
    if "prop_source" in df.columns:
        w[df["prop_source"] == "user_added"] = 1000.0
    df["sample_weight"] = w
    return df

def build_pipeline(num_cols=None, cat_cols=None):
    """Return (pipe_lr, pipe_rf) using the provided feature lists."""
    num_cols = num_cols if num_cols is not None else NUMERIC_COLS
    cat_cols = cat_cols if cat_cols is not None else CAT_COLS

    num_transform = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
        ]
    )
    cat_transform = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="most_frequent")),
            ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=True)),
        ]
    )

    pre = ColumnTransformer(
        transformers=[
            ("num", num_transform, num_cols),
            ("cat", cat_transform, cat_cols),
        ],
        remainder="drop",
        sparse_threshold=0.3,
    )

    lr = LogisticRegression(max_iter=1000, n_jobs=None)
    rf = RandomForestClassifier(
        n_estimators=300,
        max_depth=None,
        n_jobs=-1,
        random_state=42,
    )
    lr_cal = CalibratedClassifierCV(lr, method="isotonic", cv=3)

    pipe_lr = Pipeline([("pre", pre), ("clf", lr_cal)])
    pipe_rf = Pipeline([("pre", pre), ("clf", rf)])
    return pipe_lr, pipe_rf
def _simple_holdout_split(df: pd.DataFrame, frac=0.2, seed=42):
    df = df.sample(frac=1.0, random_state=seed)
    n = len(df)
    n_val = max(1, int(n * frac))
    return df.iloc[n_val:], df.iloc[:n_val]

def train_models_for_prop(
    prop_type: str, *, days_back=DEFAULT_DAYS_BACK, limit=DEFAULT_ROW_LIMIT, quiet=True
):
    sb = _supabase_client()
    df = fetch_training_rows(sb, prop_type, days_back, limit)

    if df.empty:
        if not quiet:
            print(f"⏭️  {prop_type}: no training rows.")
        return None

    df = _prep_frame(df)
    if df["y"].nunique() < 2:
        if not quiet:
            print(f"⏭️  {prop_type}: target has a single class; skipping.")
        return None

    # pick only columns that exist; keep numeric with at least one non-null
    num_used = [c for c in NUMERIC_COLS if c in df.columns and df[c].notna().any()]
    cat_used = [c for c in CAT_COLS if c in df.columns]

    # split once
    train_df, val_df = _simple_holdout_split(df, frac=0.2)
    X_tr, y_tr, w_tr = train_df[num_used + cat_used], train_df["y"], train_df["sample_weight"]
    X_v,  y_v,  w_v  =  val_df[num_used + cat_used],  val_df["y"],  val_df["sample_weight"]

    # build pipelines using the chosen columns
    pipe_lr, pipe_rf = build_pipeline(num_used, cat_used)

    try:
        p_lr = pipe_lr.predict_proba(X_v)[:, 1]
        auc_lr = roc_auc_score(y_v, p_lr, sample_weight=w_v)
    except Exception:
        auc_lr = np.nan
    try:
        p_rf = pipe_rf.predict_proba(X_v)[:, 1]
        auc_rf = roc_auc_score(y_v, p_rf, sample_weight=w_v)
    except Exception:
        auc_rf = np.nan

    if not quiet:
        print(f"📈 {prop_type}  AUC — LR: {auc_lr:.3f}  RF: {auc_rf:.3f}")

    best_model = pipe_rf if (auc_rf >= (auc_lr if not np.isnan(auc_lr) else -1)) else pipe_lr

    payload = {
        "best": best_model,
        "lr": pipe_lr,
        "rf": pipe_rf,
        "meta": {
            "prop_type": prop_type,
            "trained_at": datetime.utcnow().isoformat(),
            "days_back": days_back,
            "limit": limit,
            "auc_lr": float(auc_lr) if not np.isnan(auc_lr) else None,
            "auc_rf": float(auc_rf) if not np.isnan(auc_rf) else None,
            "features_num": num_used,   # ← use the pruned lists
            "features_cat": cat_used,   # ← use the pruned lists
        },
    }
    model_blob = io.BytesIO()
    joblib.dump(payload, model_blob, compress=3)  # smaller writes
    model_bytes = model_blob.getvalue()

    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    latest_path  = LATEST_DIR / f"{prop_type}.joblib"
    archive_path = ARCHIVE_DIR / prop_type / f"{prop_type}-{ts}.joblib"

    _atomic_write_bytes(latest_path, model_bytes)
    _atomic_write_bytes(archive_path, model_bytes)

    # maintain a simple index for hot-loaders
    index_path = LATEST_DIR / "MODEL_INDEX.json"
    index = {}
    if index_path.exists():
        try:
            index = json.loads(index_path.read_text())
            if not isinstance(index, dict):
                index = {}
        except Exception:
            index = {}
    index[prop_type] = {
        "prop_type": prop_type,
        "trained_at": datetime.utcnow().isoformat(),
        "file": latest_path.name,
        "auc_lr": float(auc_lr) if not np.isnan(auc_lr) else None,
        "auc_rf": float(auc_rf) if not np.isnan(auc_rf) else None,
        "rows": int(len(df)),
    }
    _atomic_write_bytes(index_path, json.dumps(index, indent=2).encode("utf-8"))

    if not quiet:
        print(f"✅ {prop_type}: wrote latest → {latest_path}")
        print(f"📦 archived copy → {archive_path}")

    return {
        "prop_type": prop_type,
        "auc_lr": auc_lr,
        "auc_rf": auc_rf,
        "latest_path": str(latest_path),
        "archive_path": str(archive_path),
        "rows": int(len(df)),
    }
