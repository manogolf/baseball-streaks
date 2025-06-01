import os
import requests
import pandas as pd
import joblib
from dotenv import load_dotenv
from pathlib import Path
from supabase import create_client
from collections import defaultdict
from datetime import datetime, timedelta

# Load environment variables
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

MODEL_DIR = "backend/models"
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

def get_recent_game_dates(days=2):
    today = datetime.utcnow().date()
    return [(today - timedelta(days=i)).isoformat() for i in range(1, days + 1)]

def download_model_if_missing(model_name):
    local_path = os.path.join(MODEL_DIR, model_name)
    if os.path.exists(local_path):
        return local_path

    print(f"⬇️ Downloading {model_name} from Supabase...")
    response = supabase.storage.from_("2025.05.23.mlb-models").create_signed_url(model_name, 60)

    if not response or not response.get("signedUrl"):
        print(f"❌ Failed to fetch signed URL for {model_name}")
        return None

    signed_url = response["signedUrl"]
    r = requests.get(signed_url)
    r.raise_for_status()

    with open(local_path, "wb") as f:
        f.write(r.content)

    print(f"✅ Downloaded {model_name}")
    return local_path

def predict(prop_type, input_data):
    model_filename = f"{prop_type}_model.pkl"
    model_path = download_model_if_missing(model_filename)

    print(f"🔍 Resolved model_path: {model_path}")
    if not model_path or not os.path.exists(model_path):
        return None, None

    model = joblib.load(model_path)

    features = pd.DataFrame([{
        "line_diff": input_data.get("rolling_result_avg_7", 0) - input_data.get("prop_value", 0),
        "hit_streak": input_data.get("hit_streak", 0),
        "win_streak": input_data.get("win_streak", 0),
        "is_home": input_data.get("is_home", 0),
        "opponent_encoded": input_data.get("opponent_avg_win_rate", 0.5),
    }])

    prob = model.predict_proba(features)[0][1]
    prediction = "win" if prob >= 0.5 else "loss"
    return prediction, round(float(prob), 4)

def main():
    TARGET_DATES = get_recent_game_dates(2)
    updated_count = 0

    response = supabase.table("model_training_props") \
        .select("*") \
        .in_("game_date", TARGET_DATES) \
        .is_("predicted_outcome", None) \
        .in_("outcome", ["win", "loss"]) \
        .limit(10000) \
        .execute()

    rows = response.data or []
    print(f"📦 Found {len(rows)} unresolved props across {len(TARGET_DATES)} dates...")

    props_by_player = defaultdict(list)
    for row in rows:
        props_by_player[row["player_id"]].append(row)

    for player_id, props in props_by_player.items():
        print(f"🧠 Processing {len(props)} props for player_id {player_id}...")
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
                prediction, prob = predict(row["prop_type"], features)
                if prediction is None:
                    continue

                was_correct = prediction == row["outcome"]

                supabase.table("model_training_props").update({
                    "predicted_outcome": prediction,
                    "confidence_score": prob,
                    "was_correct": was_correct
                }).eq("id", row["id"]).execute()

                updated_count += 1

            except Exception as e:
                print(f"⚠️ Error processing row ID {row['id']}: {e}")

    print(f"✅ Backfill complete: {updated_count} props updated.")

if __name__ == "__main__":
    main()
