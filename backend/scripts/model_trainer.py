# backend/scripts/model_trainer.py
"""
Train and save per-prop models (LogReg + RandomForest) to local filesystem.

- Primary source: training_examples_v1 (if exists)
- Fallback: model_training_props + merge player_derived_stats for requested features
- Target: outcome ('win'→1, 'loss'→0)
- Saves models to: $MODELS_DIR/{latest,archive} (default /var/data/models)
- Embeds exact feature lists used into joblib meta (features_num/features_cat)

Env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY  (or SUPABASE_ANON_KEY for read-only)
  MODELS_DIR (optional, default /var/data/models)
"""

from __future__ import annotations

import os, io, json
from typing import Any, Dict, List, Optional
from datetime import datetime, timedelta
from pathlib import Path

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
from pandas.api.types import is_numeric_dtype

# ---- .env (optional) ---------------------------------------------------------
try:
    from dotenv import load_dotenv
    for p in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if p.exists():
            load_dotenv(p, override=False)
except Exception:
    pass

# ---- Config ------------------------------------------------------------------
DEFAULT_DAYS_BACK = 365
DEFAULT_ROW_LIMIT = 50_000

PROP_TYPES = [
    "doubles","earned_runs","hits","hits_allowed","hits_runs_rbis","home_runs",
    "outs_recorded","rbis","runs_rbis","runs_scored","singles","stolen_bases",
    "strikeouts_batting","strikeouts_pitching","total_bases","triples","walks",
    "walks_allowed",
]

MODELS_DIR  = Path(os.environ.get("MODELS_DIR", "/var/data/models")).resolve()
LATEST_DIR  = MODELS_DIR / "latest"
ARCHIVE_DIR = MODELS_DIR / "archive"

# Feature spec JSON (same sources your registry uses)
FEATURE_JSON_CANDIDATES = [
    Path(os.environ["FEATURE_JSON"]) if os.getenv("FEATURE_JSON") else None,
    Path(__file__).resolve().parents[2] / "backend" / "scripts" / "modeling" / "feature_metadata.json",
    Path(__file__).resolve().parents[2] / "backend" / "scripts" / "modeling" / "feature_metadata_backup.json",
]
FEATURE_JSON_CANDIDATES = [p for p in FEATURE_JSON_CANDIDATES if p]

# OneHotEncoder kw compat
try:
    _ = OneHotEncoder(sparse_output=True, handle_unknown="ignore")
    _ONEHOT_KW = dict(sparse_output=True, handle_unknown="ignore")
except TypeError:
    _ONEHOT_KW = dict(sparse=True, handle_unknown="ignore")

def _debug_feature_paths():
    print("Feature JSON search paths:")
    for p in FEATURE_JSON_CANDIDATES:
        print(" -", p, "✓" if p.exists() else "✗")

# before first use of load_feature_spec():
_debug_feature_paths()

# ---- Utilities ---------------------------------------------------------------
def _atomic_write_bytes(path: Path, blob: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        f.write(blob)
    os.replace(tmp, path)

def _supabase_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or key (SERVICE_ROLE/ANON).")
    return create_client(url, key)

def _load_feature_spec() -> Dict[str, Any]:
    for p in FEATURE_JSON_CANDIDATES:
        try:
            if p and p.exists():
                return json.loads(p.read_text())
        except Exception:
            continue
    return {}

def _chunked(xs: List[Any], n: int) -> List[List[Any]]:
    return [xs[i:i+n] for i in range(0, len(xs), n)]


# ---- Data access -------------------------------------------------------------
def _fetch_from_view(sb: Client, prop_type: str, days_back: int, limit: int, cols: List[str]) -> Optional[pd.DataFrame]:
    """Try training_examples_v1 first (fast, already joined)."""
    since_date = (datetime.utcnow() - timedelta(days=days_back)).date().isoformat()
    base_cols = [
        "player_id","game_id","game_date","prop_type","line","prop_value",
        "is_home","is_pitcher","outcome","status","over_under",
        "time_of_day_bucket","game_day_of_week",
    ]
    select_cols = sorted(set(base_cols + cols))
    try:
        resp = (
            sb.table("training_examples_v1")
            .select(",".join(select_cols))
            .eq("prop_type", prop_type)
            .in_("status", ["win","loss"])
            .gte("game_date", since_date)
            .order("game_date", desc=True)
            .limit(limit)
            .execute()
        )
        rows = resp.data or []
        return pd.DataFrame(rows)
    except Exception:
        return None  # fallback path will handle

def _fetch_base_and_merge(sb: Client, prop_type: str, days_back: int, limit: int, feat_cols: List[str]) -> pd.DataFrame:
    """Fallback: model_training_props + join derived features by (player_id, game_id)."""
    since_date = (datetime.utcnow() - timedelta(days=days_back)).date().isoformat()
    resp = (
        sb.table("model_training_props")
        .select("*")
        .eq("prop_type", prop_type)
        .not_.is_("line", "null")
        .not_.is_("prop_value", "null")
        .gte("game_date", since_date)
        .order("game_date", desc=True)
        .limit(limit)
        .execute()
    )
    rows = resp.data or []
    rows = [r for r in rows if r.get("outcome") in ("win","loss")]
    df = pd.DataFrame(rows)

    if df.empty:
        return df

    # time features (mirror inference)
    if "game_date" in df.columns:
        # In case game_date is a date string
        try:
            dt = pd.to_datetime(df["game_date"])
        except Exception:
            dt = pd.to_datetime(df["game_date"], errors="coerce")
        hour = getattr(dt.dt, "hour", pd.Series([None]*len(df)))
        bucket = np.where(hour < 12, "morning", np.where(hour < 18, "afternoon", "night"))
        dow = dt.dt.day_name().str[:3]
        df["time_of_day_bucket"] = bucket
        df["game_day_of_week"] = dow

    # merge in derived features for the exact games we have
    pairs = df[["player_id","game_id"]].dropna().drop_duplicates()
    game_ids = pairs["game_id"].astype(str).tolist()
    feat_cols_needed = list(dict.fromkeys(feat_cols))  # order-preserving de-dupe

    derived_frames: List[pd.DataFrame] = []
    for chunk in _chunked(game_ids, 1000):
        r = (
            sb.table("player_derived_stats")
            .select(",".join(["player_id","game_id"] + feat_cols_needed))
            .in_("game_id", chunk)
            .execute()
        )
        part = r.data or []
        if part:
            derived_frames.append(pd.DataFrame(part))

    if derived_frames:
        derived = pd.concat(derived_frames, ignore_index=True)
    else:
        derived = pd.DataFrame(columns=["player_id","game_id"] + feat_cols_needed)

    df = df.merge(derived, on=["player_id","game_id"], how="left", suffixes=("","_der"))

    # ensure all requested features exist
    for f in feat_cols:
        if f not in df.columns:
            df[f] = np.nan

    return df


def fetch_training_rows(sb: Client, prop_type: str, days_back: int, limit: int, feat_cols: List[str]) -> pd.DataFrame:
    df = _fetch_from_view(sb, prop_type, days_back, limit, feat_cols)
    if df is not None:
        return df
    return _fetch_base_and_merge(sb, prop_type, days_back, limit, feat_cols)


# ---- Preprocessing / pipelines ----------------------------------------------
def _prep_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df.copy()

    df = df.copy()
    # target
    df["y"] = (df["outcome"] == "win").astype(int)

    # coerce binary flags
    for col in ("is_home","is_pitcher"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # sample weights: user_added gets big boost
    w = np.ones(len(df), dtype="float64")
    if "prop_source" in df.columns:
        w[df["prop_source"] == "user_added"] = 1000.0
    df["sample_weight"] = w
    return df


def build_pipeline(num_cols: List[str], cat_cols: List[str]):
    num_transform = Pipeline([("imputer", SimpleImputer(strategy="median"))])
    cat_transform = Pipeline([
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("onehot", OneHotEncoder(**_ONEHOT_KW)),
    ])
    pre = ColumnTransformer(
        transformers=[
            ("num", num_transform, num_cols),
            ("cat", cat_transform, cat_cols),
        ],
        remainder="drop",
        sparse_threshold=0.3,
    )
    lr = LogisticRegression(max_iter=1000)
    rf = RandomForestClassifier(n_estimators=300, max_depth=None, n_jobs=-1, random_state=42)
    lr_cal = CalibratedClassifierCV(lr, method="isotonic", cv=3)
    pipe_lr = Pipeline([("pre", pre), ("clf", lr_cal)])
    pipe_rf = Pipeline([("pre", pre), ("clf", rf)])
    return pipe_lr, pipe_rf


# ---- Trainer -----------------------------------------------------------------
def train_models_for_prop(prop_type: str, *, days_back=DEFAULT_DAYS_BACK, limit=DEFAULT_ROW_LIMIT, quiet=True):
    sb = _supabase_client()

    # 1) expected features from repo JSON (same universe as prediction)
    spec_all = _load_feature_spec()
    spec = spec_all.get(prop_type) or {}
    feat_list: List[str] = (
        spec.get("random_forest")
        or spec.get("rf")
        or spec.get("logistic_regression")
        or spec.get("lr")
        or spec.get("features")
        or []
    )
    if not feat_list:
        if not quiet:
            print(f"⏭️  {prop_type}: no feature list in feature_metadata.json; skipping.")
        return None

    # 2) fetch rows (view or fallback merge)
    df = fetch_training_rows(sb, prop_type, days_back, limit, feat_list)
    if df.empty:
        if not quiet:
            print(f"⏭️  {prop_type}: no training rows.")
        return None

    # 3) prep labels/weights
    df = _prep_frame(df)
    if df["y"].nunique() < 2:
        if not quiet:
            print(f"⏭️  {prop_type}: target has a single class; skipping.")
        return None

    # 4) split num/cat by dtype over the actual frame
    ALWAYS_CAT = {"time_of_day_bucket","game_day_of_week"}
    num_used = [c for c in feat_list if c in df.columns and (is_numeric_dtype(df[c]) and c not in ALWAYS_CAT)]
    cat_used = [c for c in feat_list if c in df.columns and (not is_numeric_dtype(df[c]) or c in ALWAYS_CAT)]

    # coverage hint (avoid silent regressions)
    expected = set(feat_list)
    used = set(num_used + cat_used)
    if not quiet and expected:
        cov = len(used & expected) / len(expected)
        if cov < 0.6:
            print(f"⚠️  {prop_type}: feature coverage {cov:.0%} ({len(used & expected)}/{len(expected)})")

    # 5) train/validate
    pipe_lr, pipe_rf = build_pipeline(num_used, cat_used)

    # train/val split
    df = df.sample(frac=1.0, random_state=42)
    n_val = max(1, int(len(df) * 0.2))
    train_df, val_df = df.iloc[n_val:], df.iloc[:n_val]

    X_tr, y_tr, w_tr = train_df[num_used + cat_used], train_df["y"], train_df["sample_weight"]
    X_v,  y_v,  w_v  =  val_df[num_used + cat_used],  val_df["y"],  val_df["sample_weight"]

    pipe_lr.fit(X_tr, y_tr, clf__sample_weight=w_tr)
    pipe_rf.fit(X_tr, y_tr, clf__sample_weight=w_tr)

    try:
        auc_lr = roc_auc_score(y_v, pipe_lr.predict_proba(X_v)[:,1], sample_weight=w_v)
    except Exception:
        auc_lr = np.nan
    try:
        auc_rf = roc_auc_score(y_v, pipe_rf.predict_proba(X_v)[:,1], sample_weight=w_v)
    except Exception:
        auc_rf = np.nan

    if not quiet:
        lr_s = "NaN" if np.isnan(auc_lr) else f"{auc_lr:.3f}"
        rf_s = "NaN" if np.isnan(auc_rf) else f"{auc_rf:.3f}"
        print(f"📈 {prop_type}  AUC — LR: {lr_s}  RF: {rf_s}")

    best_model = pipe_rf if (auc_rf >= (auc_lr if not np.isnan(auc_lr) else -1)) else pipe_lr

    # 6) serialize with exact lists we used
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
            "features_num": num_used,
            "features_cat": cat_used,
        },
    }
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    model_bytes = buf.getvalue()

    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    latest_path  = (LATEST_DIR / f"{prop_type}.joblib").resolve()
    archive_path = (ARCHIVE_DIR / prop_type / f"{prop_type}-{ts}.joblib").resolve()

    _atomic_write_bytes(latest_path, model_bytes)
    _atomic_write_bytes(archive_path, model_bytes)

    # 7) update MODEL_INDEX.json
    index_path = (LATEST_DIR / "MODEL_INDEX.json").resolve()
    index: Dict[str, Any] = {}
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
        "auc_lr": None if np.isnan(auc_lr) else float(auc_lr),
        "auc_rf": None if np.isnan(auc_rf) else float(auc_rf),
        "rows": int(len(df)),
        "features_num": num_used,
        "features_cat": cat_used,
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


# ---- CLI ---------------------------------------------------------------------
if __name__ == "__main__":
    import argparse, sys

    parser = argparse.ArgumentParser()
    parser.add_argument("--prop", help="Single prop type to train (default: all)", default=None)
    parser.add_argument("--days-back", type=int, default=DEFAULT_DAYS_BACK)
    parser.add_argument("--limit", type=int, default=DEFAULT_ROW_LIMIT)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    LATEST_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)

    props = [args.prop] if args.prop else PROP_TYPES
    results = []
    trained = skipped = 0

    for p in props:
        try:
            r = train_models_for_prop(p, days_back=args.days_back, limit=args.limit, quiet=args.quiet)
            if r:
                trained += 1
                results.append(r)
            else:
                skipped += 1
        except Exception as e:
            skipped += 1
            if not args.quiet:
                print(f"❌ {p}: {e}")

    print(json.dumps({"trained": trained, "skipped": skipped, "props": props, "results": results}, indent=2))
    sys.exit(0)
