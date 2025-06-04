import os
import requests
import pandas as pd
import joblib
from dotenv import load_dotenv
from pathlib import Path
from supabase import create_client
from collections import defaultdict
import time

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
        response = supabase.storage.from_("2025.05.23.mlb-models").create_signed_url(model_name, 60)
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

def predict(prop_type, input_data):
    model_filename = f"{prop_type}_model.pkl"
    model_path = download_model_if_missing(model_filename)
    print(f"🔍 Resolved model_path: {model_path}")

    if not model_path or not os.path.exists(model_path):
        return None, None

    model = joblib.load(model_path)
    features = pd.DataFrame([{
        "line_diff": (input_data.get("rolling_result_avg_7") or 0) - (input_data.get("prop_value") or 0),
        "hit_streak": input_data.get("hit_streak", 0),
        "win_streak": input_data.get("win_streak", 0),
        "is_home": input_data.get("is_home", 0),
        "opponent_encoded": input_data.get("opponent_avg_win_rate", 0.5),
    }])

    prob = model.predict_proba(features)[0][1]
    prediction = "win" if prob >= 0.5 else "loss"
    return prediction, round(float(prob), 4)

def process_batch(prop_type, batch_size=500):
    response = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .eq("source", "stat_derived") \
        .is_("predicted_outcome", None) \
        .in_("outcome", ["win", "loss"]) \
        .limit(batch_size) \
        .execute()

    rows = response.data
    if not rows:
        return 0

    grouped = defaultdict(list)
    for row in rows:
        grouped[row["player_id"]].append(row)

    print(f"🔍 {prop_type}: {len(rows)} unresolved props fetched")

    updates = 0
    for player_id, props in grouped.items():
        for row in props:
            try:
                features = {
                    "prop_value": row.get("prop_value", 0),
                    "rolling_result_avg_7": row.get("rolling_result_avg_7", 0),
                    "hit_streak": row.get("hit_streak", 0),
                    "win_streak": row.get("win_streak", 0),
                    "is_home": row.get("is_home", 0),
                    "opponent_avg_win_rate": row.get("opponent_avg_win_rate", 0.5),
                }

                prediction, prob = predict(prop_type, features)
                if prediction is None:
                    continue

                was_correct = prediction == row["outcome"]
                supabase.table("model_training_props").update({
                    "predicted_outcome": prediction,
                    "confidence_score": prob,
                    "was_correct": was_correct,
                }).eq("id", row["id"]).execute()

                updates += 1
            except Exception as e:
                print(f"⚠️ Error processing row ID {row['id']}: {e}")
    return updates

def main():
    print("📆 Starting batch prediction loop for stat_derived props...")
    for prop_type in PROP_TYPES:
        batch_num = 0
        while True:
            batch_num += 1
            print(f"🔁 {prop_type} | Batch {batch_num}")
            updates = process_batch(prop_type, batch_size=500)
            if updates == 0:
                print(f"✅ {prop_type}: No more pending predictions.")
                break

    print("✅ All prop types processed.")

if __name__ == "__main__":
    main()
