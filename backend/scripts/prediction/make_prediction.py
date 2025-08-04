#  backend/scripts/prediction/make_prediction.py

import os
import json
import subprocess


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

    base_dir = os.path.abspath(os.path.dirname(__file__))
    model_dir = os.path.join(base_dir, f"../../models/{prop_type}")
    rf_model_path = os.path.join(model_dir, f"{prop_type}_random_forest.pkl")
    lr_model_path = os.path.join(model_dir, f"{prop_type}_logistic_regression.pkl")
    script_path = os.path.join(base_dir, "predict_single_prop.py")

    features_input = {
        "prop_type": prop_type,
        "features": extract_features_only(prepared_data),
    }

    try:
        result = subprocess.run(
            ["python3", script_path, json.dumps(features_input), rf_model_path, lr_model_path],
            capture_output=True,
            text=True,
            check=True,
        )
        print("📈 Prediction result:", result.stdout.strip())
        return json.loads(result.stdout.strip())
    except subprocess.CalledProcessError as e:
        print("❌ Subprocess error:", e.stderr)
        raise RuntimeError(f"Prediction failed: {e.stderr.strip()}")
