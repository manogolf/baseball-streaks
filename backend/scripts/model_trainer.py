# backend/scripts/model_trainer.py

import os
import pandas as pd
import joblib
from dotenv import load_dotenv
from supabase import create_client
from sklearn.ensemble import RandomForestClassifier

load_dotenv()

# 🔐 Connect to Supabase using service role
supabase = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"]
)

MODEL_DIR = "models"

def fetch_data(prop_type):
    """Pulls resolved training data for a specific prop type."""
    response = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .in_("outcome", ["win", "loss"]) \
        .execute()

    df = pd.DataFrame(response.data)
    return df


def train_and_save_model(prop_type):
    """Trains and saves a model for a given normalized prop type."""
    df = fetch_data(prop_type)

    if df.empty:
        raise ValueError(f"No training data found for: {prop_type}")

    # ✅ Feature Engineering
    df["line_diff"] = (
    df["rolling_result_avg_7"].fillna(0).astype(float)
    - df["prop_value"].fillna(0).astype(float)
)

    df["opponent_encoded"] = df.get("opponent_avg_win_rate", 0.5)
    df["hit_streak"] = df.get("hit_streak", 0)
    df["win_streak"] = df.get("win_streak", 0)
    df["is_home"] = df.get("is_home", 0)

    X = df[["line_diff", "hit_streak", "win_streak", "is_home", "opponent_encoded"]]
    y = df["outcome"].map({"win": 1, "loss": 0})

    # ✅ Train model
    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X, y)

    # ✅ Save model
    os.makedirs(MODEL_DIR, exist_ok=True)
    model_path = os.path.join(MODEL_DIR, f"{prop_type}_model.pkl")
    joblib.dump(model, model_path)

    print(f"💾 Saved model: {model_path}")
