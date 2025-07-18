# File: backend/scripts/modeling/train_models.py

import os
import sys
import argparse
import pandas as pd
import numpy as np
import joblib
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import train_test_split
from supabase import create_client
from build_feature_vector import build_feature_vector


# ───── Env Setup ─────
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ───── Model Save Path ─────
MODEL_DIR = "backend/models"
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

# ----- Ensure Model Exists -------
def ensure_models_bucket():
    # Checks list of buckets; creates if missing
    resp = supabase.storage.list_buckets()
    if not any(b['name'] == 'models' for b in resp):
        supabase.storage.create_bucket('models', public=True)  # or False


# ───── CLI Args ─────
parser = argparse.ArgumentParser()
parser.add_argument("--prop-type", required=True, help="Prop type to train")
args = parser.parse_args()
prop_type = args.prop_type

# ───── Data Fetch ─────
def fetch_training_data(prop_type):
    print(f"📅 Fetching training data for {prop_type}...")
    query = supabase.table("model_training_props") \
        .select("*") \
        .eq("prop_type", prop_type) \
        .or_("prop_source.eq.user_added,prop_source.eq.mlb_api") \
        .not_.is_("result", "null") \
        .not_.is_("outcome", "null")

    response = query.execute()
    rows = response.data or []

    # Sample mlb_api data to reduce imbalance
    user_added = [r for r in rows if r["prop_source"] == "user_added"]
    mlb_api = [r for r in rows if r["prop_source"] == "mlb_api"]

    np.random.seed(42)
    mlb_sample = list(np.random.choice(mlb_api, size=int(len(mlb_api) * 0.3), replace=False)) if mlb_api else []

    return user_added + mlb_sample


# ───── Model Trainer ─────
def train_and_save_model(model_name, model, X_train, y_train, X_test, y_test, prop_type):
    print(f"🩼 Checking features before training {model_name}...")

    # Select only features from the YAML spec
    from build_feature_vector import load_feature_spec
    feature_spec = load_feature_spec()
    feature_spec = load_feature_spec()
    allowed_features = list(feature_spec["features"].keys())

    X_train = X_train[[col for col in X_train.columns if col in allowed_features]]
    X_test = X_test[[col for col in X_test.columns if col in allowed_features]]

    # Fill any NaNs in remaining columns with 0
    X_train = X_train.fillna(0).infer_objects(copy=False)
    X_test = X_test.fillna(0).infer_objects(copy=False)


    X_train = X_train.select_dtypes(include=[np.number])
    X_test = X_test.select_dtypes(include=[np.number])

    dropped_cols = [col for col in X_train.columns if X_train[col].dtype == 'object']
    if dropped_cols:
       print(f"⚠️ Dropping non-numeric columns from X_train: {dropped_cols}")


    # Reset indices
    X_train = X_train.reset_index(drop=True)
    y_train = y_train.reset_index(drop=True)
    X_test = X_test.reset_index(drop=True)
    y_test = y_test.reset_index(drop=True)

    # Fit and evaluate
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    metrics = classification_report(y_test, y_pred, output_dict=True)
    metrics["roc_auc"] = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])

    model_filename = f"{prop_type}_{model_name}.pkl"
    model_path = os.path.join(MODEL_DIR, model_filename)
    joblib.dump(model, model_path)
    print(f"✅ {model_name} saved: {model_path}")

    with open(model_path, "rb") as f:
        storage_path = f"{prop_type}/{model_filename}"
        supabase.storage.from_("models").upload(storage_path, f, {"upsert": "true"})

    import hashlib, json

    def hash_features(df):
        payload = {
            "columns": list(df.columns),
            "yaml_version": os.getenv("FEATURE_SPEC_VERSION", "unknown")
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]

    total_rows = len(y_train) + len(y_test)
    positive_rate = float(y_train.mean())
    features_hash = hash_features(X_train)

    supabase.table("model_metadata").insert({
        "prop_type": prop_type,
        "model_type": model_name,
        "trained_at": datetime.utcnow().isoformat(),
        "training_rows": total_rows,
        "positive_class_rate": positive_rate,
        "features_hash": features_hash,
        "metrics": metrics,
        "storage_path": storage_path
    }).execute()


# ───── Main ─────
def main():
    rows = fetch_training_data(prop_type)
    features, targets = [], []

    for row in rows:
        if row.get("outcome") not in ["win", "loss"]:
            continue
        vector = build_feature_vector(row)
        if vector is None:
            continue
        features.append(vector)
        targets.append(1 if row["outcome"] == "win" else 0)

    if not features:
        print(f"⚠️ No usable data for {prop_type}.")
        return

    X = pd.DataFrame(features)
    y = pd.Series(targets)
    X_train, X_test, y_train, y_test = train_test_split(X, y, stratify=y, test_size=0.2, random_state=42)

    print(f"🧠 Training models for {prop_type}...")

    train_and_save_model(
        "random_forest",
        RandomForestClassifier(n_estimators=200, random_state=42, n_jobs=-1),
        X_train,
        y_train,
        X_test,
        y_test,
        prop_type
    )

    train_and_save_model(
        "logistic_regression",
        LogisticRegression(max_iter=1000, solver="liblinear"),
        X_train,
        y_train,
        X_test,
        y_test,
        prop_type
    )

    print(f"✅ Training complete for {prop_type}")


if __name__ == "__main__":
    main()
