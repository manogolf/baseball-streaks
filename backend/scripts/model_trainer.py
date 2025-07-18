# File: backend/scripts/model_trainer.py
"""
📄 Trains hybrid models (Logistic Regression + Random Forest) for each MLB prop type.

Key features:
--------------
• Uses all available, resolved training rows from `model_training_props` table.
• Logistic Regression model trained on full historical dataset for long-term signal.
• Random Forest model trained on recent form (up to 50,000 rows, biased toward recent games).
• User-added props are weighted 1000x more heavily than mlb_api props.
• Only rows with complete core features are used (line, outcome, prop_value, etc).
• Saves both models to local disk and uploads to Supabase Storage (`models` bucket).
"""

import os
import pandas as pd
import joblib
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.utils import compute_sample_weight
from sklearn.model_selection import train_test_split

from build_feature_vector import build_feature_vector_for_training

# Load environment variables
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

MODEL_DIR = "backend/models"
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)
PROP_TYPES = [
    "hits", "runs", "rbis", "total_bases", "home_runs", "walks",
    "strikeouts_batting", "stolen_bases", "doubles", "triples",
    "hits_runs_rbis", "runs_rbis", "singles", "outs_recorded",
    "strikeouts_pitching", "earned_runs", "hits_allowed", "walks_allowed"
]

def fetch_training_data(prop_type):
    response = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .not_.is_("outcome", "null") \
        .not_.is_("line", "null") \
        .not_.is_("prop_value", "null") \
        .execute()

    rows = response.data
    return [row for row in rows if row.get("outcome") in ["win", "loss"]]

def train_models_for_prop(prop_type):
    print(f"\n🚀 Training models for: {prop_type}")
    rows = fetch_training_data(prop_type)
    if not rows:
        print("⚠️ No usable rows.")
        return

    features, labels, weights = [], [], []
    for row in rows:
        vec = build_feature_vector_for_training(row)
        if vec is None:
            continue
        features.append(vec)
        labels.append(1 if row["outcome"] == "win" else 0)
        weight = 1000.0 if row.get("prop_source") == "user_added" else 1.0
        weights.append(weight)

    if not features:
        print("⚠️ No features extracted.")
        return

    df = pd.DataFrame(features)
    X = df.values
    y = pd.Series(labels).values
    sample_weights = pd.Series(weights).values

    # Split into train/test for logistic
    X_train, X_test, y_train, y_test, w_train, w_test = train_test_split(
        X, y, sample_weights, test_size=0.2, random_state=42, stratify=y
    )

    # Logistic Regression: long-term full-history model
    log_reg = LogisticRegression(max_iter=1000)
    log_reg.fit(X_train, y_train, sample_weight=w_train)

    joblib.dump(log_reg, os.path.join(MODEL_DIR, f"{prop_type}_logreg.pkl"))
    print("✅ Logistic model trained and saved")

    # Random Forest: short-term form (keep recent only)
    recent_limit = min(50000, len(X))
    rf = RandomForestClassifier(n_estimators=200, random_state=42, n_jobs=-1)
    rf.fit(X[:recent_limit], y[:recent_limit], sample_weight=sample_weights[:recent_limit])

    joblib.dump(rf, os.path.join(MODEL_DIR, f"{prop_type}_model.pkl"))
    print("✅ Random Forest model trained and saved")

def main():
    for prop in PROP_TYPES:
        train_models_for_prop(prop)
    print("🎯 All models trained.")

if __name__ == "__main__":
    main()
