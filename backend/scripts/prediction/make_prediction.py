#  backend/scripts/prediction/make_prediction.py

import os
import joblib
import numpy as np


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

    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_dir = os.path.abspath(os.path.join(script_dir, "../../../models", prop_type))
    rf_model_path = os.path.join(model_dir, f"{prop_type}_random_forest.pkl")
    lr_model_path = os.path.join(model_dir, f"{prop_type}_logistic_regression.pkl")

    # Convert features to the input format expected by model
    X = np.array([list(features.values())])

    # Load models
    rf_model = joblib.load(rf_model_path)
    lr_model = joblib.load(lr_model_path)

    # Predict probabilities
    rf_prob = rf_model.predict_proba(X)[0][1]
    lr_prob = lr_model.predict_proba(X)[0][1]
    final_prob = (rf_prob + lr_prob) / 2

    print("📈 Prediction result (blended):", final_prob)

    return {
        "probability": final_prob,
        "rf_probability": rf_prob,
        "lr_probability": lr_prob
    }
