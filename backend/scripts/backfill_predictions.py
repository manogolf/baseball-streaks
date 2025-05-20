import os
from dotenv import load_dotenv
from supabase import create_client
import pandas as pd
import joblib

# Load environment variables
load_dotenv()

# Initialize Supabase client
supabase_url = os.environ.get("SUPABASE_URL")
supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(supabase_url, supabase_key)

# Define prediction function
def predict(prop_type, input_data):
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))  # points to script dir
    model_path = os.path.join(BASE_DIR, "..", "..", "models", f"{prop_type}_model.pkl")

    print(f"🔍 Resolved model_path: {model_path}")

    if not os.path.exists(model_path):
        print(f"⚠️ Model file not found for prop_type: {prop_type}")
        return None, None

    model = joblib.load(model_path)

    # Safely extract values
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

        # Update the record in Supabase
        supabase.table("model_training_props").update({
            "predicted_outcome": prediction,
            "confidence_score": prob,
            "was_correct": was_correct
        }).eq("id", row["id"]).execute()

        updated_count += 1

    except Exception as e:
        print(f"⚠️ Error processing row ID {row['id']}: {e}")

print(f"✅ Backfill complete: {updated_count} props updated.")
