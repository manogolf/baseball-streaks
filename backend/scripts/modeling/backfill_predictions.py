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

def download_model_if_missing(model_name, max_retries=3):
    local_path = os.path.join(MODEL_DIR, model_name)
    if os.path.exists(local_path):
        return local_path

    print(f"⬇️ Downloading {model_name} from Supabase...")

    for attempt in range(1, max_retries + 1):
        response = supabase.storage.from_("models").create_signed_url(model_name, 60)
        url = response.get("data", {}).get("signedUrl")

        if url:
            try:
                r = requests.get(url)
                r.raise_for_status()
                with open(local_path, "wb") as f:
                    f.write(r.content)
                print(f"✅ Downloaded {model_name}")
                return local_path
            except Exception as e:
                print(f"❌ Download failed on attempt {attempt}: {e}")
        else:
            print(f"⚠️ Attempt {attempt} failed for {model_name}: No signed URL returned")

        time.sleep(2)

    print(f"❌ Error downloading {model_name} after {max_retries} attempts")
    return None

def predict(prop_type, row):
    model_filename = f"{prop_type}_model.pkl"
    model_path = download_model_if_missing(model_filename)

    if not model_path or not os.path.exists(model_path):
        return None, None

    model = joblib.load(model_path)

    try:
        features = build_feature_vector(row)
        df = pd.DataFrame([features])
    except Exception as e:
        print(f"❌ Failed to build feature vector: {e}")
        return None, None

    prob = model.predict_proba(df)[0][1]
    prediction = "win" if prob >= 0.5 else "loss"
    return prediction, round(float(prob), 4)

def process_batch(prop_type, batch_size=500):
    response = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .eq("prop_source", "mlb_api") \
        .is_("predicted_outcome", "null") \
        .eq("status", "final") \
        .limit(batch_size) \
        .execute()

    rows = response.data or []
    if not rows:
        return 0

    updates = 0
    for row in rows:
        try:
            prediction, prob = predict(prop_type, row)
            if prediction is None:
                continue

            was_correct = prediction == row.get("outcome")
            timestamp = datetime.now(timezone.utc).isoformat()

            supabase.table("model_training_props").update({
                "predicted_outcome": prediction,
                "confidence_score": prob,
                "was_correct": was_correct,
                "prediction_timestamp": timestamp
            }).eq("id", row["id"]).execute()

            print(f"✅ {row.get('player_name')} → {prediction} ({prob}) | Correct? {was_correct}")
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
