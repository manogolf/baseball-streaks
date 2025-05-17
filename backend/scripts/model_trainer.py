import os
import pandas as pd
import joblib
from dotenv import load_dotenv
from supabase import create_client
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score

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
        pd.to_numeric(df["rolling_result_avg_7"], errors="coerce").fillna(0)
        - pd.to_numeric(df["prop_value"], errors="coerce").fillna(0)
    )
    df["opponent_encoded"] = df.get("opponent_avg_win_rate", 0.5)
    df["hit_streak"] = df.get("hit_streak", 0)
    df["win_streak"] = df.get("win_streak", 0)
    df["is_home"] = df.get("is_home", 0)

    X = df[["line_diff", "hit_streak", "win_streak", "is_home", "opponent_encoded"]]
    y = df["outcome"].map({"win": 1, "loss": 0})

    if y.nunique() < 2:
        raise ValueError(f"Not enough outcome variation to train {prop_type}")

    # ✅ Train model
    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X, y)

    # ✅ Evaluate
    y_pred = model.predict(X)
    acc = accuracy_score(y, y_pred)
    print(f"✅ {prop_type} model accuracy: {acc:.3f}")

    # ✅ Print feature importances
    importances = model.feature_importances_
    print("📊 Feature importances:", dict(zip(X.columns, importances)))

    # ✅ Save model
    os.makedirs(MODEL_DIR, exist_ok=True)
    model_path = os.path.join(MODEL_DIR, f"{prop_type}_model.pkl")
    joblib.dump(model, model_path)
    print(f"💾 Saved model: {model_path}")
