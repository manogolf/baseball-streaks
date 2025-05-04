# Run or import from backend
# Usage: see bottom

import pandas as pd
import joblib
import os

MODEL_DIR = "../models"

# Central function to score any prop
def predict_prop(prop_type: str, input_data: dict) -> dict:
    """
    Load the correct model for prop_type and score the given input.
    
    input_data keys:
        'prop_value', 'rolling_result_avg_7', 'hit_streak', 'win_streak',
        'is_home', 'opponent_avg_win_rate' (optional)
    """
    normalized_type = prop_type.strip()
    model_path = os.path.join(MODEL_DIR, f"{normalized_type}_model.pkl")
    print(f"📂 Looking for model file: {model_path}")

    if not os.path.exists(model_path):
        return {"error": f"Model not found for prop type: {prop_type}"}
    
    model = joblib.load(model_path)

    # Feature engineering
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

    # Predict
    prob = model.predict_proba(features)[0][1]
    prediction = "win" if prob >= 0.5 else "loss"

    return {
        "prop_type": prop_type,
        "prediction": prediction,
       "probability": float(round(prob, 4))  # 👈 force np.float64 → regular float
    }

# 🧪 Example
if __name__ == "__main__":
    example = {
        "prop_value": 1.5,
        "rolling_result_avg_7": 1.3,
        "hit_streak": 3,
        "win_streak": 2,
        "is_home": 1,
        "opponent_avg_win_rate": 0.53
    }

    result = predict_prop("Hits", example)
    print("🔮", result)
