# File: backend/scripts/modeling/backfill_predictions.py
"""
Backfills model predictions into the `model_training_props` table.

- Loads RF + LR models from persistent disk (MODEL_DIR)
- Builds feature vectors with build_feature_vector(...)
- Blends probabilities (RF+LR) to set predicted_outcome + confidence_score
- Updates only predicted_outcome, confidence_score, was_correct, prediction_timestamp
- Touches only mlb_api, resolved rows where predicted_outcome IS NULL

Note: This script intentionally DOES NOT access Supabase Storage.
It only uses Supabase DB for reading/writing rows to backfill.
"""

import os
import pandas as pd
import numpy as np
import joblib
from time import perf_counter
from datetime import datetime, timezone
from collections import defaultdict
from dotenv import load_dotenv
from pathlib import Path
from supabase import create_client
from build_feature_vector import build_feature_vector

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

# Optional: limit which types to process: PROP_TYPES="rbis,hits,walks"
ENV_PROP_TYPES = os.getenv("PROP_TYPES")
ENV_PROP_TYPES = [p.strip() for p in ENV_PROP_TYPES.split(",")] if ENV_PROP_TYPES else None

# Map DB prop_type -> model folder/file prefix on disk
# (Your disk has plural 'rbis'; also tolerate 'rbi' by mapping to 'rbis'.)
PROP_TYPE_ALIASES = {
    "rbis": "rbis",
    "rbi": "rbis",
    "runs": "runs_scored",  # if legacy rows exist with 'runs'
}

# ──────────────────────────────────────────────────────────────────────────────
# Helpers: model paths & availability (DISK ONLY)
# ──────────────────────────────────────────────────────────────────────────────
def model_type_for(db_type: str) -> str:
    return PROP_TYPE_ALIASES.get(db_type, db_type)

def _model_filename(model_prop_type: str, kind: str) -> str:
    # kind: "rf" or "lr"
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

def load_models(model_prop_type: str):
    ok, missing = models_available(model_prop_type)
    if not ok:
        raise FileNotFoundError(f"Models missing for {model_prop_type}: {', '.join(missing)}")
    rf = joblib.load(_model_path(model_prop_type, "rf"))
    lr = joblib.load(_model_path(model_prop_type, "lr"))
    return rf, lr

# ──────────────────────────────────────────────────────────────────────────────
# Discover pending prop types (DB → distinct)
# ──────────────────────────────────────────────────────────────────────────────
def fetch_pending_prop_types() -> list[str]:
    if ENV_PROP_TYPES:
        return ENV_PROP_TYPES

    resp = (
        supabase.table("model_training_props")
        .select("prop_type", distinct=True)
        .eq("prop_source", "mlb_api")
        .eq("status", "resolved")
        .is_("predicted_outcome", None)
        .limit(2000)
        .execute()
    )
    rows = resp.data or []
    return sorted({r["prop_type"] for r in rows if r.get("prop_type")})

# ──────────────────────────────────────────────────────────────────────────────
# Row normalization helpers (avoid pandas Series truthiness errors)
# ──────────────────────────────────────────────────────────────────────────────
def _to_scalar(v):
    if isinstance(v, pd.Series):
        return v.iloc[0] if not v.empty else None
    if isinstance(v, pd.DataFrame):
        return v.iloc[0, 0] if not v.empty else None
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, (list, tuple)) and len(v) == 1:
        return v[0]
    return v

def _normalize_row(row):
    if hasattr(row, "to_dict"):
        row = row.to_dict()
    elif isinstance(row, pd.Series):
        row = row.to_dict()
    return {k: _to_scalar(v) for k, v in row.items()}

# ──────────────────────────────────────────────────────────────────────────────
# Prediction (blend RF + LR) — DISK ONLY MODELS
# ──────────────────────────────────────────────────────────────────────────────
def predict(model_prop_type: str, row: dict) -> tuple[str, float]:
    rf_model, lr_model = load_models(model_prop_type)
    X, _ = build_feature_vector(pd.DataFrame([row]))
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
SUMMARY = defaultdict(lambda: {
    "batches": 0,
    "fetched": 0,
    "attempted": 0,
    "updated": 0,
    "skipped": 0,
    "no_features": 0,
    "model_errors": 0,
    "errors": 0,
})

def print_summary(summary: dict, started_at: float) -> None:
    elapsed = perf_counter() - started_at
    print("\n" + "=" * 72)
    print("📈 Backfill Predictions — Run Summary")
    print(f"⏱️  Elapsed: {elapsed:0.1f}s")
    print("-" * 72)
    hdr = f"{'prop_type':20} {'batches':7} {'fetched':7} {'attempt':8} {'updated':8} {'skipped':8} {'no_feat':7} {'model_err':9} {'errors':7}"
    print(hdr)
    print("-" * 72)
    totals = {k: 0 for k in ["batches","fetched","attempted","updated","skipped","no_features","model_errors","errors"]}
    for ptype in sorted(summary.keys()):
        m = summary[ptype]
        print(f"{ptype:20} {m['batches']:7d} {m['fetched']:7d} {m['attempted']:8d} {m['updated']:8d} {m['skipped']:8d} {m['no_features']:7d} {m['model_errors']:9d} {m['errors']:7d}")
        for k in totals:
            totals[k] += m[k]
    print("-" * 72)
    print(f"{'TOTAL':20} {totals['batches']:7d} {totals['fetched']:7d} {totals['attempted']:8d} {totals['updated']:8d} {totals['skipped']:8d} {totals['no_features']:7d} {totals['model_errors']:9d} {totals['errors']:7d}")
    print("=" * 72 + "\n")

# ──────────────────────────────────────────────────────────────────────────────
# Batch processing
# ──────────────────────────────────────────────────────────────────────────────
def process_batch(db_prop_type: str, model_prop_type: str, batch_size: int = BATCH_SIZE) -> int:
    response = (
        supabase.table("model_training_props")
        .select("*")
        .eq("prop_type", db_prop_type)             # DB type here
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
            row_dict = _normalize_row(row)

            print(
                f"🔍 Fetching missing fields for "
                f"player_id={row_dict.get('player_id')}, "
                f"game_id={row_dict.get('game_id')}, "
                f"team={row_dict.get('team')}"
            )

            prediction, prob = predict(model_prop_type, row_dict)
            if prediction is None:
                SUMMARY[db_prop_type]["skipped"] += 1
                print(f"⚠️ Skipped row ID {row_dict.get('id')} — prediction failed")
                continue

            outcome = row_dict.get("outcome")
            was_correct = (prediction == outcome) if isinstance(outcome, str) and outcome else None
            timestamp = datetime.now(timezone.utc).isoformat()

            supabase.table("model_training_props").update({
                "predicted_outcome": prediction,
                "confidence_score": float(prob),
                "was_correct": was_correct,
                "prediction_timestamp": timestamp
            }).eq("id", row_dict["id"]).execute()

            print(f"✅ {row_dict.get('player_name')} → {prediction} ({prob:.3f}) | Correct? {was_correct}")
            updates += 1
            SUMMARY[db_prop_type]["updated"] += 1

        except Exception as e:
            msg = str(e).lower()
            if "no usable features" in msg:
                SUMMARY[db_prop_type]["no_features"] += 1
            elif "model" in msg and ("missing" in msg or "no such file" in msg or "file not found" in msg or "invalid load key" in msg):
                SUMMARY[db_prop_type]["model_errors"] += 1
            else:
                SUMMARY[db_prop_type]["errors"] += 1
            print(f"❌ Failed on row {row.get('id') if isinstance(row, dict) else row}: {e}")

    return updates

# ──────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ──────────────────────────────────────────────────────────────────────────────
def main():
    started_at = perf_counter()

    print(f"📆 Starting batch prediction loop (disk models at {MODEL_DIR})")

    db_prop_types = fetch_pending_prop_types()
    if not db_prop_types:
        print("✅ No pending rows. Nothing to do.")
        print_summary(SUMMARY, started_at)
        return

    # Inventory print (disk only)
    print("🧰 Model inventory (disk):")
    for db_pt in db_prop_types:
        mt = model_type_for(db_pt)
        ok, missing = models_available(mt)
        if ok:
            print(f"  • {db_pt} (model: {mt}): OK")
        else:
            print(f"  • {db_pt} (model: {mt}): MISSING ({'; '.join(missing)})")

    # Run batches
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
