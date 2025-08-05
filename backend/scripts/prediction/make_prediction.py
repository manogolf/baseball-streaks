# File: backend/scripts/prediction/make_prediction.py

import os
import joblib
import numpy as np
import tempfile
import requests
from supabase import create_client

# 🔐 Supabase setup
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# 📦 Load model from Supabase
def load_model_from_supabase(bucket: str, path: str):
    print(f"📥 Loading model from Supabase: {bucket}/{path}")
    res = supabase.storage.from_(bucket).create_signed_url(path, 3600)
    signed_url = res['signedURL']
    with tempfile.NamedTemporaryFile(delete=True) as tmp:
        response = requests.get(signed_url)
        response.raise_for_status()
        tmp.write(response.content)
        tmp.flush()
        return joblib.load(tmp.name)

# 🎯 Predict
def make_prediction(payload: dict, rf_model=None, lr_model=None) -> dict:
    prop_type = payload["prop_type"]
    features = payload["features"]
    print(f"📊 Running prediction for {prop_type} with features: {features}")

    # Fallback: load models if not provided
    if rf_model is None:
        path = f"{prop_type}/{prop_type}_random_forest_compressed.pkl"
        rf_model = load_model_from_supabase("models", path)

    if lr_model is None:
        path = f"{prop_type}/{prop_type}_logistic_regression_compressed.pkl"
        lr_model = load_model_from_supabase("models", path)

    # 🚀 Predict
    X = np.array([list(features.values())])
    rf_proba = rf_model.predict_proba(X)[0][1]
    lr_proba = lr_model.predict_proba(X)[0][1]
    hybrid = round((rf_proba + lr_proba) / 2, 4)

    print(f"🔢 RF: {rf_proba:.4f}, LR: {lr_proba:.4f}, Hybrid: {hybrid:.4f}")

    return {
        "prop_type": prop_type,
        "hybrid_score": hybrid,
        "random_forest_score": rf_proba,
        "logistic_regression_score": lr_proba,
        "input_features": features,
    }
