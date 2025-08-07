# File: backend/scripts/prediction/make_prediction.py

import os
import joblib
import numpy as np
import tempfile
import requests
from supabase import create_client
import json

# 📥 Load feature metadata (only once)
FEATURE_METADATA_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../modeling/feature_metadata.json")
)

_feature_metadata_cache = None

def load_feature_metadata():
    global _feature_metadata_cache
    if _feature_metadata_cache is not None:
        return _feature_metadata_cache

    with open(FEATURE_METADATA_PATH, "r") as f:
        _feature_metadata_cache = json.load(f)
    return _feature_metadata_cache

# 🔐 Supabase setup
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# 📦 Cache for already-loaded models
model_cache = {}

# 📦 Load model from Supabase (with in-process cache)
def load_model_from_supabase(bucket: str, path: str):
    cache_key = (bucket, path)
    if cache_key in model_cache:
        return model_cache[cache_key]

    print(f"📥 Downloading model: {bucket}/{path}")
    res = supabase.storage.from_(bucket).create_signed_url(path, 3600)
    signed_url = res['signedURL']
    with tempfile.NamedTemporaryFile(delete=True) as tmp:
        response = requests.get(signed_url)
        response.raise_for_status()
        tmp.write(response.content)
        tmp.flush()
        model = joblib.load(tmp.name)
        model_cache[cache_key] = model
        return model

# 🎯 Predict
def make_prediction(payload: dict) -> dict:
    prop_type = payload["prop_type"]
    features = payload["features"]

    # Feature alignment
    def sanitize_features(input_features, expected_features):
        return [float(input_features.get(f, 0.0)) for f in expected_features]

    # Get features to align with trained model
    feature_metadata = load_feature_metadata()
    expected_rf_features = feature_metadata[prop_type]["random_forest"]
    expected_lr_features = feature_metadata[prop_type]["logistic_regression"]

    X_rf = np.array([sanitize_features(features, expected_rf_features)])
    X_lr = np.array([sanitize_features(features, expected_lr_features)])

    print(f"📊 Predicting for {prop_type} with {len(features)} features")

    # Load models (once per process)
    rf_model = load_model_from_supabase("models", f"{prop_type}/{prop_type}_random_forest_compressed.pkl")
    lr_model = load_model_from_supabase("models", f"{prop_type}/{prop_type}_logistic_regression_compressed.pkl")

    # Predict
    rf_proba = rf_model.predict_proba(X_rf)[0][1]
    lr_proba = lr_model.predict_proba(X_lr)[0][1]
    hybrid = round((rf_proba + lr_proba) / 2, 4)

    print(f"🔢 RF: {rf_proba:.4f}, LR: {lr_proba:.4f}, Hybrid: {hybrid:.4f}")

    recommendation = "over" if hybrid >= 0.5 else "under"

    return {
        "probability": float(hybrid),
        "recommendation": recommendation,
        "predicted_outcome": recommendation,
        "confidence_score": float(hybrid)
}
