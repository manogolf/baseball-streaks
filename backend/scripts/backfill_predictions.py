import os
import requests
import pandas as pd
import joblib
from dotenv import load_dotenv
from pathlib import Path
from supabase import create_client

# Load env vars
load_dotenv()

# Init Supabase client
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# Ensure model directory exists
MODEL_DIR = "backend/models"
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

def download_model_if_missing(model_name):
    local_path = os.path.join(MODEL_DIR, model_name)
    
    if os.path.exists(local_path):
        print(f"📁 Model already exists locally: {local_path}")
        return local_path

    print(f"⬇️ Downloading {model_name} from Supabase...")

    try:
        response = supabase.storage.from_("2025.05.23.mlb-models").create_signed_url(model_name, 60)
        print(f"📤 Raw Supabase response for {model_name}:\n{response}")
    except Exception as e:
        print(f"❌ Supabase create_signed_url failed: {e}")
        return None

    if not response or "data" not in response or not response["data"].get("signedUrl"):
        print(f"❌ Failed to retrieve signed URL for {model_name}")
        return None

    signed_url = response["data"]["signedUrl"]

    try:
        r = requests.get(signed_url)
        r.raise_for_status()
    except Exception as e:
        print(f"❌ Failed to download model from signed URL: {e}")
        return None

    try:
        with open(local_path, "wb") as f:
            f.write(r.content)
        print(f"✅ Downloaded and saved model: {local_path}")
        return local_path
    except Exception as e:
        print(f"❌ Failed to write model to disk: {e}")
        return None




def predict(prop_type, input_data):
    model_filename = f"{prop_type}_model.pkl"
    model_path = download_model_if_missing(model_filename)

    print(f"🔍 Resolved model_path: {model_path}")
    if not os.path.exists(model_path):
        print(f"⚠️ Model file still not found: {model_path}")
        return None, None

    model = joblib.load(model_path)

    rolling_avg = input_data.get("rolling_result_avg_7") or 0
    prop_value = input_data.get("prop_value") or 0
    line_diff = rolling_avg - prop_value

    features = pd.DataFrame([{
        "line_diff": line_diff,
        "hit_streak": input_data.get("hit_streak", 0),
        "win_streak": input_data.get("win_streak", 0),
        "is_home": input_data.get("is_home", 0),
        "opponent_encoded": input_data.get("opponent_avg_win_rate", 0.5)
    }])

    prob = model.predict_proba(features)[0][1]
    prediction = "win" if prob >= 0.5 else "loss"
    return prediction, round(float(prob), 4)

# Fetch unresolved rows
response = supabase.table("model_training_props") \
    .select("*") \
    .is_("predicted_outcome", None) \
    .in_("outcome", ["win", "loss"]) \
    .limit(500) \
    .execute()

rows = response.data
print(f"📦 Found {len(rows)} props to backfill predictions...")

updated_count = 0

for row in rows:
    try:
        features = {
            "prop_value": row.get("prop_value", 0),
            "rolling_result_avg_7": row.get("rolling_result_avg_7", 0),
            "hit_streak": row.get("hit_streak", 0),
            "win_streak": row.get("win_streak", 0),
            "is_home": row.get("is_home", 0),
            "opponent_avg_win_rate": row.get("opponent_avg_win_rate", 0.5)
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
