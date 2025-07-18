# File: backend/scripts/modeling/train_models.py

import os
import joblib
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report
from pathlib import Path

# Load environment variables
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# Paths
MODEL_DIR = "backend/models"
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

PROP_TYPES = [
    "hits", "runs", "rbis", "total_bases", "home_runs", "walks",
    "strikeouts_batting", "stolen_bases", "doubles", "triples",
    "hits_runs_rbis", "runs_rbis", "singles", "outs_recorded",
    "strikeouts_pitching", "earned_runs", "hits_allowed", "walks_allowed"
]

def fetch_training_data(prop_type):
    response = (
        supabase.table("model_training_props")
        .select("*")
        .eq("prop_type", prop_type)
        .eq("prop_source", "mlb_api")
        .not_.is_("outcome", "null")
        .limit(10000)
        .execute()
    )
    return pd.DataFrame(response.data)

def preprocess(df):
    label_map = {"win": 1, "loss": 0}
    df = df[df["outcome"].isin(label_map)].copy()
    df["target"] = df["outcome"].map(label_map)

    drop_cols = ["outcome", "target", "created_at", "status", "result", "prop_source", "id"]
    drop_cols = [col for col in drop_cols if col in df.columns]
    X = df.drop(columns=drop_cols)
    y = df["target"]

    X = pd.get_dummies(X, drop_first=True)
    return X, y

def train_and_save_model(X, y, prop_type):
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    model = RandomForestClassifier(n_estimators=200, random_state=42, n_jobs=-1)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    print(f"\n📊 {prop_type.upper()} Model Evaluation:")
    print(classification_report(y_test, y_pred))

    model_path = os.path.join(MODEL_DIR, f"{prop_type}_model.pkl")
    joblib.dump(model, model_path)
    print(f"✅ Saved model: {model_path}")

def main():
    for prop_type in PROP_TYPES:
        print(f"\n🚀 Training model for: {prop_type}")
        df = fetch_training_data(prop_type)
        if df.empty:
            print(f"⚠️ No training data for {prop_type}. Skipping...")
            continue

        try:
            X, y = preprocess(df)
            train_and_save_model(X, y, prop_type)
        except Exception as e:
            print(f"❌ Error training model for {prop_type}: {e}")

if __name__ == "__main__":
    main()
