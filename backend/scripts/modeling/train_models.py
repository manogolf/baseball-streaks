# File: backend/scripts/modeling/train_models.py

import os
import sys
import argparse
import pandas as pd
import numpy as np
import joblib
import hashlib
import json
from datetime import datetime
from postgrest.exceptions import APIError
from pathlib import Path
from dotenv import load_dotenv
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import train_test_split
from supabase import create_client
from build_feature_vector import build_feature_vector, load_feature_spec
import time

# ───── Env Setup ─────
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ───── Model Save Path ─────
MODEL_DIR = "backend/models"
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

# ───── CLI Args ─────
parser = argparse.ArgumentParser()
parser.add_argument("--prop-type", required=True, help="Prop type to train")
parser.add_argument("--mlb-sample-ratio", type=float, default=1.0, help="Proportion of mlb_api props to include (default 1.0)")
args = parser.parse_args()
prop_type = args.prop_type
mlb_sample_ratio = args.mlb_sample_ratio

# ───── Data Fetch ─────
def fetch_training_data(prop_type, mlb_sample_ratio):
    print(f"📅 Fetching training data for {prop_type}...")
    query = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .or_("prop_source.eq.user_added,prop_source.eq.mlb_api") \
        .not_.is_("result", "null") \
        .not_.is_("outcome", "null")

    try:
        print("📤 Executing Supabase query for:", prop_type)
        response = query.execute()
        rows = response.data or []

        # Sample mlb_api data to reduce imbalance
        user_added = [r for r in rows if r["prop_source"] == "user_added"]
        mlb_api = [r for r in rows if r["prop_source"] == "mlb_api"]

        np.random.seed(42)
        mlb_sample = list(np.random.choice(
            mlb_api,
            size=int(len(mlb_api) * mlb_sample_ratio),
            replace=False
        )) if mlb_api else []

        return user_added + mlb_sample

    except APIError as e:
        print("❌ Supabase API Error:", e)
        print("🧾 Full error response:", e.args)
        raise

# ───── Model Trainer ─────
def train_and_save_model(model_name, model, X_train, y_train, X_test, y_test, prop_type):
    print(f"🩼 Checking features before training {model_name}...")
    feature_spec = load_feature_spec()
    allowed_features = list(feature_spec["features"].keys())
    print("📋 Allowed features from YAML:", allowed_features)

    X_train = X_train.reindex(columns=allowed_features).fillna(0).infer_objects(copy=False)
    X_test = X_test.reindex(columns=allowed_features).fillna(0).infer_objects(copy=False)

    # Remove all-zero columns
    X_train = X_train.loc[:, (X_train != 0).any(axis=0)]
    X_test = X_test[X_train.columns]

    print("📉 Non-zero feature coverage:")
    print((X_train != 0).sum().sort_values())

    X_train = X_train.select_dtypes(include=[np.number])
    X_test = X_test.select_dtypes(include=[np.number])

    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)
    probs = model.predict_proba(X_test)[:, 1]

    print("🔮 Predicted probabilities (sample):", probs[:10])
    print("📊 Probability range:", probs.min(), "to", probs.max())

    unique_preds = set(y_pred)
    if len(unique_preds) == 1:
        print(f"⚠️ Model predicted only class {list(unique_preds)[0]} — may indicate underfitting.")

    metrics = classification_report(y_test, y_pred, output_dict=True)
    metrics["roc_auc"] = roc_auc_score(y_test, probs)

    if model_name == "random_forest" and hasattr(model, "feature_importances_"):
        importances = model.feature_importances_
        top_features = sorted(zip(X_train.columns, importances), key=lambda x: -x[1])[:10]
        print("🌟 Top features by importance:")
        for name, score in top_features:
            print(f"  {name}: {score:.4f}")

    model_filename = f"{prop_type}_{model_name}.pkl"
    model_path = os.path.join(MODEL_DIR, model_filename)
    joblib.dump(model, model_path)
    print(f"✅ {model_name} saved: {model_path}")

# ───── Main ─────
def main():
    rows = fetch_training_data(prop_type, mlb_sample_ratio)
    features, targets = [], []

    for idx, row in enumerate(rows):
        if row.get("outcome") not in ["win", "loss"]:
            continue

        try:
            vector = build_feature_vector(row)
        except Exception as e:
            print(f"❌ Error building feature for row {idx}: {e}")
            continue

        if vector is None:
            continue

        features.append(vector)
        targets.append(1 if row["outcome"] == "win" else 0)

        if idx % 100 == 0 and idx > 0:
            print(f"⏳ Processed {idx} rows... sleeping briefly")
            time.sleep(1)

        if idx % 1000 == 0 and idx > 0:
            print("♻️ Refreshing Supabase client to avoid stream exhaustion")
            global supabase
            supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    if not features:
        print(f"⚠️ No usable data for {prop_type}.")
        return

    X = pd.DataFrame(features)
    y = pd.Series(targets)
    X_train, X_test, y_train, y_test = train_test_split(X, y, stratify=y, test_size=0.2, random_state=42)

    print("🔎 Class balance in y_train:", y_train.value_counts().to_dict())
    print("🔎 Class balance in y_test:", y_test.value_counts().to_dict())
    print("🔍 Sample row:", X_train.iloc[0].to_dict())
    print(f"🧠 Training models for {prop_type}...")

    train_and_save_model("random_forest", RandomForestClassifier(n_estimators=200, random_state=42, n_jobs=-1), X_train, y_train, X_test, y_test, prop_type)
    train_and_save_model("logistic_regression", LogisticRegression(max_iter=1000, solver="liblinear"), X_train, y_train, X_test, y_test, prop_type)

    print(f"✅ Training complete for {prop_type}")

if __name__ == "__main__":
    main()
