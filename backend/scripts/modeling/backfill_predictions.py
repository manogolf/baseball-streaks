# File: backend/scripts/modeling/backfill_predictions.py
"""
Backfills model predictions into the `model_training_props` table.

- Loads RF + LR models from persistent disk (MODEL_DIR)
- Builds feature vectors with build_feature_vector(...)
- Blends probabilities (RF+LR) to set predicted_outcome + confidence_score
- Updates only predicted_outcome, confidence_score, was_correct, prediction_timestamp
- Touches only mlb_api, resolved rows where predicted_outcome IS NULL

NOTE: No Supabase Storage calls. Disk-only models.
"""

from __future__ import annotations

import os
import sys
import json
import importlib
import importlib.util
from time import perf_counter
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path
import traceback 
import pandas as pd
import numpy as np
import joblib
from dotenv import load_dotenv
import traceback
from supabase import create_client

def _enable_pandas_truthiness_compat():
    """
    Let legacy feature code use `if series:` / `if df:` safely.
    Makes Series truthiness -> .any(), DataFrame truthiness -> values.any().
    """
    try:
        import pandas as _pd
        from pandas.core.generic import NDFrame

        def _ndframe_bool(self):  # Series/DataFrame both inherit NDFrame
            try:
                # empty -> False
                if getattr(self, "empty", False):
                    return False
                # Series: .any() is scalar; DataFrame: values.any()
                try:
                    a = self.any()
                except Exception:
                    a = getattr(self, "values", self).any()
                # convert to pure bool
                return bool(getattr(a, "item", lambda: a)())
            except Exception:
                return False

        # Patch both names used by pandas for truthiness
        NDFrame.__bool__ = _ndframe_bool
        NDFrame.__nonzero__ = _ndframe_bool
    except Exception as e:
        print(f"⚠️ Pandas truthiness compat patch failed: {e}")

# ──────────────────────────────────────────────────────────────────────────────
# Env & clients
# ──────────────────────────────────────────────────────────────────────────────
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

MODEL_DIR = os.getenv("MODEL_DIR", "/var/data/models")
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

BATCH_SIZE = int(os.getenv("BACKFILL_BATCH_SIZE", "500"))
ENV_PROP_TYPES = os.getenv("PROP_TYPES")
ENV_PROP_TYPES = [p.strip() for p in ENV_PROP_TYPES.split(",")] if ENV_PROP_TYPES else None

# Map DB prop_type -> model folder/file prefix on disk
PROP_TYPE_ALIASES = {
    "rbis": "rbis",
    "rbi": "rbis",
    "runs": "runs_scored",
}

# ──────────────────────────────────────────────────────────────────────────────
# Utilities: scalar normalization (fixes "truth value of a Series is ambiguous")
# ──────────────────────────────────────────────────────────────────────────────
def _scalarize(x):
    if isinstance(x, pd.Series):
        return _scalarize(x.iloc[0] if not x.empty else None)
    if isinstance(x, pd.DataFrame):
        return _scalarize(x.iloc[0, 0] if not x.empty else None)
    if isinstance(x, np.ndarray):
        return _scalarize(x.flat[0]) if x.size else None
    if isinstance(x, np.generic):
        return x.item()
    if isinstance(x, (list, tuple)) and len(x) == 1:
        return _scalarize(x[0])
    return x


def _normalize_row(row) -> dict:
    if hasattr(row, "to_dict"):
        row = row.to_dict()
    elif isinstance(row, pd.Series):
        row = row.to_dict()
    elif not isinstance(row, dict):
        row = dict(row)
    out = {}
    for k, v in row.items():
        if isinstance(v, dict):
            out[k] = {kk: _scalarize(vv) for kk, vv in v.items()}
        else:
            out[k] = _scalarize(v)
    # ensure key fields are plain scalars
    for k in ("id", "player_id", "game_id", "team", "player_name", "outcome", "prop_type"):
        if k in out:
            out[k] = _scalarize(out[k])
    return out


def to_plain_scalars(d: dict) -> dict:
    """
    Force-convert any pandas/NumPy/list scalars to plain Python scalars.
    Guaranteed: no pd.Series/pd.DataFrame/np.generic/list-of-1 remain.
    """
    s = pd.DataFrame([d]).iloc[0]  # coerce then unwrap
    out = {}
    for k, v in s.items():
        if isinstance(v, pd.Series):
            out[k] = v.iloc[0] if not v.empty else None
        elif isinstance(v, pd.DataFrame):
            out[k] = v.iloc[0, 0] if not v.empty else None
        elif isinstance(v, (list, tuple)) and len(v) == 1:
            out[k] = v[0]
        elif isinstance(v, np.generic):
            out[k] = v.item()
        else:
            out[k] = v
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Model I/O (disk-only) + cache
# ──────────────────────────────────────────────────────────────────────────────
def model_type_for(db_type: str) -> str:
    return PROP_TYPE_ALIASES.get(db_type, db_type)


def _model_filename(model_prop_type: str, kind: str) -> str:
    return f"{model_prop_type}_{'random_forest' if kind == 'rf' else 'logistic_regression'}.pkl"


def _model_path(model_prop_type: str, kind: str) -> str:
    folder = os.path.join(MODEL_DIR, model_prop_type)
    Path(folder).mkdir(parents=True, exist_ok=True)
    return os.path.join(folder, _model_filename(model_prop_type, kind))


def models_available(model_prop_type: str) -> tuple[bool, list[str]]:
    missing = []
    rf_path = _model_path(model_prop_type, "rf")
    lr_path = _model_path(model_prop_type, "lr")
    if not os.path.exists(rf_path):
        missing.append(rf_path)
    if not os.path.exists(lr_path):
        missing.append(lr_path)
    return (len(missing) == 0, missing)


_MODEL_CACHE: dict[str, tuple[object, object]] = {}


def load_models(model_prop_type: str):
    if model_prop_type in _MODEL_CACHE:
        return _MODEL_CACHE[model_prop_type]
    ok, missing = models_available(model_prop_type)
    if not ok:
        raise FileNotFoundError(f"Models missing for {model_prop_type}: {', '.join(missing)}")
    rf = joblib.load(_model_path(model_prop_type, "rf"))
    lr = joblib.load(_model_path(model_prop_type, "lr"))
    _MODEL_CACHE[model_prop_type] = (rf, lr)
    return rf, lr


# ──────────────────────────────────────────────────────────────────────────────
# Robust, lazy import of build_feature_vector
# ──────────────────────────────────────────────────────────────────────────────
def _load_build_feature_vector():
    """
    Returns the function build_feature_vector(DataFrame) -> (X, y_or_None).
    Tries multiple import strategies so this works whether run as a module or script.
    """
    # 1) Package import (module execution)
    try:
        mod = importlib.import_module("backend.scripts.modeling.build_feature_vector")
        return getattr(mod, "build_feature_vector")
    except Exception:
        pass

    # 2) Add this directory to path and try local import (script execution)
    modeling_dir = Path(__file__).resolve().parent
    if str(modeling_dir) not in sys.path:
        sys.path.insert(0, str(modeling_dir))
    try:
        mod = importlib.import_module("build_feature_vector")
        return getattr(mod, "build_feature_vector")
    except Exception:
        pass

    # 3) Direct file load as last resort
    bfv_path = modeling_dir / "build_feature_vector.py"
    if bfv_path.exists():
        spec = importlib.util.spec_from_file_location("build_feature_vector_fallback", bfv_path)
        if spec and spec.loader:
            mod = importlib.util.module_from_spec(spec)
            sys.modules["build_feature_vector_fallback"] = mod
            spec.loader.exec_module(mod)  # type: ignore
            return getattr(mod, "build_feature_vector")

    # If we get here, fail with a clear, actionable error
    raise ImportError(
        "Could not import build_feature_vector. "
        f"Tried package import and local path: {modeling_dir}. "
        "Ensure backend/scripts/modeling/build_feature_vector.py exists and "
        "local imports inside it (e.g., transform_features) are resolvable."
    )


# ──────────────────────────────────────────────────────────────────────────────
# Prediction (blend RF + LR) — disk-only models
# ──────────────────────────────────────────────────────────────────────────────
def predict(model_prop_type: str, row: dict) -> tuple[str, float]:
    _enable_pandas_truthiness_compat()  # if you kept this shim
    build_feature_vector = _load_build_feature_vector()
    rf_model, lr_model = load_models(model_prop_type)

    row = to_plain_scalars(row)
    X, _ = build_feature_vector(pd.DataFrame([row]))

    # 🔧 extra safety (handles dict/Series/ndarray)
    if isinstance(X, pd.DataFrame):
        pass
    elif isinstance(X, pd.Series):
        X = X.to_frame().T
    elif isinstance(X, dict):
        X = pd.DataFrame([X])
    elif isinstance(X, np.ndarray):
        X = pd.DataFrame([X]) if X.ndim == 1 else pd.DataFrame(X)
    else:
        X = pd.DataFrame([X])

    if X.empty:
        raise ValueError(f"No usable features for prediction: {row.get('player_name')}")

    rf_prob = float(rf_model.predict_proba(X)[0][1])
    lr_prob = float(lr_model.predict_proba(X)[0][1])
    avg_prob = (rf_prob + lr_prob) / 2.0
    pred = "over" if avg_prob >= 0.5 else "under"
    return pred, avg_prob


# ──────────────────────────────────────────────────────────────────────────────
# Summary tracking & printout
# ──────────────────────────────────────────────────────────────────────────────
SUMMARY = defaultdict(
    lambda: {
        "batches": 0,
        "fetched": 0,
        "attempted": 0,
        "updated": 0,
        "skipped": 0,
        "no_features": 0,
        "model_errors": 0,
        "errors": 0,
    }
)


def print_summary(summary: dict, started_at: float) -> None:
    elapsed = perf_counter() - started_at
    print("\n" + "=" * 72)
    print("📈 Backfill Predictions — Run Summary")
    print(f"⏱️  Elapsed: {elapsed:0.1f}s")
    print("-" * 72)
    hdr = f"{'prop_type':20} {'batches':7} {'fetched':7} {'attempt':8} {'updated':8} {'skipped':8} {'no_feat':7} {'model_err':9} {'errors':7}"
    print(hdr)
    print("-" * 72)
    totals = {
        k: 0
        for k in [
            "batches",
            "fetched",
            "attempted",
            "updated",
            "skipped",
            "no_features",
            "model_errors",
            "errors",
        ]
    }
    for ptype in sorted(summary.keys()):
        m = summary[ptype]
        print(
            f"{ptype:20} {m['batches']:7d} {m['fetched']:7d} {m['attempted']:8d} {m['updated']:8d} {m['skipped']:8d} {m['no_features']:7d} {m['model_errors']:9d} {m['errors']:7d}"
        )
        for k in totals:
            totals[k] += m[k]
    print("-" * 72)
    print(
        f"{'TOTAL':20} {totals['batches']:7d} {totals['fetched']:7d} {totals['attempted']:8d} {totals['updated']:8d} {totals['skipped']:8d} {totals['no_features']:7d} {totals['model_errors']:9d} {totals['errors']:7d}"
    )
    print("=" * 72 + "\n")


# ──────────────────────────────────────────────────────────────────────────────
# Batch processing
# ──────────────────────────────────────────────────────────────────────────────
def process_batch(db_prop_type: str, model_prop_type: str, batch_size: int = BATCH_SIZE) -> int:
    response = (
        supabase.table("model_training_props")
        .select("*")
        .eq("prop_type", db_prop_type)
        .eq("prop_source", "mlb_api")
        .is_("predicted_outcome", None)
        .eq("status", "resolved")
        .limit(batch_size)
        .execute()
    )

    rows = response.data or []
    SUMMARY[db_prop_type]["batches"] += 1
    SUMMARY[db_prop_type]["fetched"] += len(rows)

    print(f"📊 {db_prop_type}: Fetched {len(rows)} pending rows")
    if not rows:
        return 0

    updates = 0
    for row in rows:
        SUMMARY[db_prop_type]["attempted"] += 1
        try:
            # Strong normalization to scalars
            row_dict = to_plain_scalars(_normalize_row(row))

            # 🔒 sanity: if anything is still a Series/DataFrame, sanitize again & assert
            for k, v in list(row_dict.items()):
                if isinstance(v, (pd.Series, pd.DataFrame)):
                    row_dict[k] = to_plain_scalars({k: v}).get(k)
            # assert nothing weird remains (will throw with the exact key)
            for k, v in row_dict.items():
                if isinstance(v, (pd.Series, pd.DataFrame)):
                    raise TypeError(f"{k} remained a {type(v).__name__}")

            pid = str(row_dict.get("player_id"))
            gid = str(row_dict.get("game_id"))
            team = str(row_dict.get("team"))
            print(f"🔍 player_id={pid}, game_id={gid}, team={team}")

            prediction, prob = predict(model_prop_type, row_dict)
            if prediction is None:
                SUMMARY[db_prop_type]["skipped"] += 1
                continue

            outcome = row_dict.get("outcome")
            was_correct = (prediction == outcome) if isinstance(outcome, str) and outcome else None
            timestamp = datetime.now(timezone.utc).isoformat()

            supabase.table("model_training_props").update(
                {
                    "predicted_outcome": prediction,
                    "confidence_score": float(prob),
                    "was_correct": was_correct,
                    "prediction_timestamp": timestamp,
                }
            ).eq("id", row_dict["id"]).execute()

            print(f"✅ {row_dict.get('player_name')} → {prediction} ({prob:.3f}) | Correct? {was_correct}")
            updates += 1
            SUMMARY[db_prop_type]["updated"] += 1

        except Exception as e:
            # 🔎 Print full traceback so you see exactly where the Series truthiness happens
            traceback.print_exc()
            msg = str(e).lower()
            if "no usable features" in msg:
                SUMMARY[db_prop_type]["no_features"] += 1
            elif "model" in msg and (
                "missing" in msg or "no such file" in msg or "file not found" in msg or "invalid load key" in msg
            ):
                SUMMARY[db_prop_type]["model_errors"] += 1
            else:
                SUMMARY[db_prop_type]["errors"] += 1
            print(f"❌ Failed on row {row.get('id') if isinstance(row, dict) else row}: {e}")

    return updates


def fetch_pending_prop_types() -> list[str]:
    resp = (
        supabase.table("model_training_props")
        .select("prop_type")  # Supabase v2 client: no distinct= here
        .eq("prop_source", "mlb_api")
        .eq("status", "resolved")  # finalized games only
        .is_("predicted_outcome", None)  # needs backfill
        .limit(2000)
        .execute()
    )
    rows = resp.data or []
    return sorted({r.get("prop_type") for r in rows if r.get("prop_type")})


# ──────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ──────────────────────────────────────────────────────────────────────────────
def main():
    started_at = perf_counter()

    # Early banner + env
    print("📆 Starting batch prediction loop")
    print(json.dumps({"model_dir": MODEL_DIR, "batch_size": BATCH_SIZE, "prop_types_env": ENV_PROP_TYPES}, indent=2))

    db_prop_types = ENV_PROP_TYPES or fetch_pending_prop_types()
    if not db_prop_types:
        print("✅ No pending rows. Nothing to do.")
        print_summary(SUMMARY, started_at)
        return

    print("🧰 Model inventory (disk):")
    for db_pt in db_prop_types:
        mt = model_type_for(db_pt)
        ok, missing = models_available(mt)
        if ok:
            print(f"  • {db_pt} (model: {mt}): OK")
        else:
            print(f"  • {db_pt} (model: {mt}): MISSING ({'; '.join(missing)})")

    for db_pt in db_prop_types:
        mt = model_type_for(db_pt)
        ok, missing = models_available(mt)
        if not ok:
            SUMMARY[db_pt]["model_errors"] += 1
            print(f"⏭️  {db_pt}: Skipping — models missing for '{mt}':\n     " + "\n     ".join(missing))
            continue

        batch_num = 0
        while True:
            batch_num += 1
            print(f"🔁 {db_pt} | Batch {batch_num}")
            updates = process_batch(db_pt, mt)
            if updates == 0:
                print(f"✅ {db_pt}: No more pending predictions.")
                break

    print("✅ All prop types processed.")
    print_summary(SUMMARY, started_at)


if __name__ == "__main__":
    main()
