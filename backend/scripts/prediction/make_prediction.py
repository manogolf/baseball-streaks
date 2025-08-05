#  backend/scripts/prediction/make_prediction.py

import os
import joblib
import numpy as np
import tempfile
import requests
from supabase import create_client
import os

# 🔐 Setup Supabase client
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# 📦 Reusable loader
def load_model_from_supabase(bucket: str, path: str):
    res = supabase.storage.from_(bucket).create_signed_url(path, 3600)
    signed_url = res['signedURL']

    with tempfile.NamedTemporaryFile(delete=True) as tmp:
        response = requests.get(signed_url)
        response.raise_for_status()
        tmp.write(response.content)
        tmp.flush()
        return joblib.load(tmp.name)


backend_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))

def extract_features_only(prepared_data):
    return {
        "is_home": prepared_data.get("is_home"),
        "opponent_encoded": prepared_data.get("opponent_encoded"),
        "game_day_of_week": prepared_data.get("game_day_of_week"),
        "time_of_day_bucket": prepared_data.get("time_of_day_bucket"),
        "starting_pitcher_id": prepared_data.get("starting_pitcher_id"),
        "rolling_result_avg_7": prepared_data.get("rolling_result_avg_7"),
        "hit_streak": prepared_data.get("hit_streak"),
        "win_streak": prepared_data.get("win_streak"),
        "line_diff": prepared_data.get("line_diff"),
    }

def make_prediction(prepared_data):
    prop_type = prepared_data["prop_type"]
    features = prepared_data["features"]

    # 🔁 Load compressed models from Supabase
    rf_model = load_model_from_supabase(
        "models", f"{prop_type}/{prop_type}_random_forest_compressed.pkl"
    )
    lr_model = load_model_from_supabase(
        "models", f"{prop_type}/{prop_type}_logistic_regression_compressed.pkl"
    )

    print(f"📦 Loaded models for: {prop_type}")

    # 🧮 Run prediction
    X = np.array([list(features.values())])
    rf_prob = rf_model.predict_proba(X)[0][1]
    lr_prob = lr_model.predict_proba(X)[0][1]
    final_prob = (rf_prob + lr_prob) / 2

    print("📈 Prediction result (blended):", final_prob)

    return {
        "probability": final_prob,
        "rf_probability": rf_prob,
        "lr_probability": lr_prob,
    }
