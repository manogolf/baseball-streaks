# File: backend/scripts/modeling/backfill_predictions.py
"""
📄 File: backfill_predictions.py

This script backfills model predictions into the `model_training_props` table.

It does so by:
- Loading trained models for supported prop types
- Generating feature vectors for past resolved props (with full stats)
- Running inference to compute predicted probabilities and classes
- Upserting the predictions into the `model_training_props` table

⚠️ This script assumes:
- `prop_value`, `line`, `outcome`, and all derived stats are already present
- Models are pre-downloaded and locally available

🔄 Only these fields are updated:
- predicted_outcome
- confidence_score
- was_correct
- prediction_timestamp

🛡️ User-added predictions (with `prop_source = user_added`) are never overwritten.
"""

import os
import requests
import pandas as pd
import joblib
from dotenv import load_dotenv
from pathlib import Path
from supabase import create_client
from collections import defaultdict
import time
from datetime import datetime, timezone
from build_feature_vector import build_feature_vector

# Load environment variables
load_dotenv()

# Init Supabase client
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# Ensure model directory exists
MODEL_DIR = "backend/models"
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

PROP_TYPES = [
    "hits", "runs", "rbis", "total_bases", "home_runs", "walks",
    "strikeouts_batting", "stolen_bases", "doubles", "triples",
    "hits_runs_rbis", "runs_rbis", "singles", "outs_recorded",
    "strikeouts_pitching", "earned_runs", "hits_allowed", "walks_allowed"
]

def download_model_if_missing(model_filename: str, prop_type: str) -> str:
    """
    Downloads a model file from Supabase storage if it doesn't exist locally.
    Returns the local file path.
    """
    folder = f"models/{prop_type}"
    local_path = os.path.join(folder, model_filename)
    supabase_path = f"{prop_type}/{model_filename}"  # FIXED: include subfolder

    if not os.path.exists(folder):
        os.makedirs(folder)

    if not os.path.exists(local_path):
        print(f"⬇️  Downloading {model_filename} from Supabase...")
        response = supabase.storage.from_("models").create_signed_url(supabase_path, 60)
        if "signedURL" not in response:
            raise Exception(f"❌ Model file(s) missing for {prop_type}: {response}")
        signed_url = response["signedURL"]
        r = requests.get(signed_url)
        with open(local_path, "wb") as f:
            f.write(r.content)

    return local_path

def predict(prop_type: str, row: dict) -> tuple[str, float]:
    lr_filename = f"{prop_type}_logistic_regression.pkl"
    rf_filename = f"{prop_type}_random_forest.pkl"

    rf_path = download_model_if_missing(rf_filename, prop_type)
    lr_path = download_model_if_missing(lr_filename, prop_type)

    # ... your existing logic for loading models and generating predictions ...

    rf_model = joblib.load(rf_path)
    lr_model = joblib.load(lr_path)

    # Build feature vector
    X, _ = build_feature_vector(pd.DataFrame([row]))  # _ is y_train but not needed
    if X.empty:
        raise ValueError(f"❌ No usable features for prediction: {row['player_name']}")

    rf_pred = rf_model.predict(X)[0]
    rf_prob = rf_model.predict_proba(X)[0][1]

    lr_pred = lr_model.predict(X)[0]
    lr_prob = lr_model.predict_proba(X)[0][1]

    # Simple average
    avg_prob = (rf_prob + lr_prob) / 2
    blended_pred = "over" if avg_prob >= 0.5 else "under"

    return blended_pred, avg_prob

def process_batch(prop_type, batch_size=500):
    response = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .eq("prop_source", "mlb_api") \
        .is_("predicted_outcome", None) \
        .eq("status", "resolved") \
        .limit(batch_size) \
        .execute()

    rows = response.data or []
    print(f"📊 {prop_type}: Fetched {len(rows)} pending rows")

    if not rows:
        return 0

    updates = 0
    for row in rows:
        try:
            # Convert Supabase row to dict
            row_dict = row.to_dict() if hasattr(row, "to_dict") else row

            # 🛠️ Flatten known problematic fields
            for key in ("player_id", "game_id", "team", "outcome"):
                val = row_dict.get(key)
                if isinstance(val, pd.Series):
                    row_dict[key] = val.iloc[0]

            # ✅ Sanitize all Series or DataFrames
            for k, v in row_dict.items():
                if isinstance(v, pd.Series):
                    row_dict[k] = v.iloc[0]
                elif isinstance(v, pd.DataFrame):
                    row_dict[k] = v.iloc[0, 0]

            # 🔍 Confirm clean values
            print(
                f"🔍 Fetching missing fields for "
                f"player_id={row_dict.get('player_id')}, "
                f"game_id={row_dict.get('game_id')}, "
                f"team={row_dict.get('team')}"
            )

            prediction, prob = predict(prop_type, row_dict)
            if prediction is None:
                print(f"⚠️ Skipped row ID {row.get('id')} — prediction failed")
                continue

            was_correct = prediction == row.get("outcome")
            timestamp = datetime.now(timezone.utc).isoformat()

            supabase.table("model_training_props").update({
                "predicted_outcome": prediction,
                "confidence_score": prob,
                "was_correct": was_correct,
                "prediction_timestamp": timestamp
            }).eq("id", row["id"]).execute()

            print(f"✅ {row.get('player_name')} → {prediction} ({prob:.3f}) | Correct? {was_correct}")
            updates += 1

        except Exception as e:
            print(f"❌ Failed on row {row.get('id')}: {e}")

    return updates

def main():
    print("📆 Starting batch prediction loop for stat_derived props...")
    for prop_type in PROP_TYPES:
        batch_num = 0
        while True:
            batch_num += 1
            print(f"🔁 {prop_type} | Batch {batch_num}")
            updates = process_batch(prop_type)
            if updates == 0:
                print(f"✅ {prop_type}: No more pending predictions.")
                break

    print("✅ All prop types processed.")

if __name__ == "__main__":
    main()
