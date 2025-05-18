import pandas as pd
import joblib
import os
import pathlib
import json


with open(os.path.join(os.path.dirname(__file__), 'prop_types.json')) as f:
    PROP_MODEL_MAP = json.load(f)


# Get absolute path to project root (2 levels up from score_any_prop.py)
PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
MODEL_DIR = PROJECT_ROOT / "models"

def predict_prop(prop_type: str, input_data: dict) -> dict:
    over_under = input_data.get("over_under", "under")  # default to under

    """
    Load and apply the correct model for a given prop type using normalized input.
    
    input_data keys:
        - 'prop_value'
        - 'rolling_result_avg_7'
        - 'hit_streak'
        - 'win_streak'
        - 'is_home'
        - 'opponent_avg_win_rate' (optional)
    """

    # Normalize and validate prop_type
    from app.utils.prop_utils import normalize_prop_type

    normalized_key = normalize_prop_type(prop_type)


    canonical_type = PROP_MODEL_MAP.get(normalized_key)

    if not canonical_type:
        print(f"❌ Unknown or unsupported prop type: {prop_type}")
        return {"error": f"Unsupported or unknown prop type: {prop_type}"}

    model_path = MODEL_DIR / f"{canonical_type}_model.pkl"
    print(f"📂 Looking for model file: {model_path}")

    if not os.path.exists(model_path):
        print(f"❌ Model file not found: {model_path}")
        return {"error": f"Model not found for prop type: {canonical_type}"}

    try:
        model = joblib.load(model_path)
    except Exception as e:
        print(f"❌ Failed to load model: {e}")
        return {"error": "Model load failure"}

    # Prepare input features
    line_diff = input_data['rolling_result_avg_7'] - input_data['prop_value']
    is_home = input_data.get('is_home', 0)
    opponent_encoded = input_data.get('opponent_avg_win_rate', 0)

    features = pd.DataFrame([{
        'line_diff': line_diff,
        'hit_streak': input_data['hit_streak'],
        'win_streak': input_data['win_streak'],
        'is_home': is_home,
        'opponent_encoded': opponent_encoded
    }])

    # Run prediction
    try:
        over_under = input_data.get("over_under", "under")
        # load model, compute features, etc...

        prob = model.predict_proba(features)[0][1]
        raw_prediction = "win" if prob >= 0.5 else "loss"

        if over_under == "over":
            prediction = "win" if raw_prediction == "loss" else "loss"
        else:
            prediction = raw_prediction

        return {
            "predicted_outcome": prediction,
            "confidence_score": float(round(prob, 4))
        }

    except Exception as e:
        print(f"❌ Prediction error: {e}")
        return {"error": "Prediction failed"}