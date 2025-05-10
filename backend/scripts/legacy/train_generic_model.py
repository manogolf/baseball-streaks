import pandas as pd
import joblib
import os
from supabase import create_client
from dotenv import load_dotenv
from sklearn.ensemble import RandomForestClassifier

load_dotenv()

supabase = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"]
)

MODEL_DIR = "models"

def fetch_data(prop_type):
    response = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .in_("outcome", ["win", "loss"]) \
        .execute()

    df = pd.DataFrame(response.data)
    return df

def train_and_save_model(prop_type):
    df = fetch_data(prop_type)

    if df.empty:
        raise ValueError("No training data found.")

    df["line_diff"] = df["rolling_result_avg_7"].fillna(0) - df["prop_value"].fillna(0)
    df["opponent_encoded"] = df.get("opponent_avg_win_rate", 0.5)
    df["hit_streak"] = df.get("hit_streak", 0)
    df["win_streak"] = df.get("win_streak", 0)
    df["is_home"] = df.get("is_home", 0)

    X = df[["line_diff", "hit_streak", "win_streak", "is_home", "opponent_encoded"]]
    y = df["outcome"].map({"win": 1, "loss": 0})

    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X, y)

    filename = f"{prop_type}_model.pkl"
    model_path = os.path.join(MODEL_DIR, filename)
    joblib.dump(model, model_path)

    print(f"💾 Saved model: {model_path}")
