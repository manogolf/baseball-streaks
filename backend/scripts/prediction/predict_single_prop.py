# File: backend/scripts/prediction/predict_single_prop.py

import os
import sys
import json
import joblib
import pandas as pd
from dotenv import load_dotenv
import yaml

# ───── Load environment variables ─────
load_dotenv()

# ───── Input: JSON from sys.argv ─────
input_data = json.loads(sys.argv[1])
prop_type = input_data.get("prop_type")
features = input_data.get("features")

if not prop_type or not features:
    print(json.dumps({"error": "Missing prop_type or features in input."}))
    sys.exit(1)

# ───── Paths ─────
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../"))
FEATURE_SPEC_PATH = os.path.join(PROJECT_ROOT, "model_features.yaml")
model_dir = os.path.join(PROJECT_ROOT, "backend/models", prop_type)
rf_model_path = os.path.join(model_dir, f"{prop_type}_random_forest.pkl")
log_model_path = os.path.join(model_dir, f"{prop_type}_logistic_regression.pkl")

# ───── Load models ─────
if not os.path.exists(rf_model_path) or not os.path.exists(log_model_path):
    print(json.dumps({"error": f"Model(s) not found for prop type: {prop_type}"}))
    sys.exit(1)

rf_model = joblib.load(rf_model_path)
log_model = joblib.load(log_model_path)

# ───── Load feature spec ─────
with open(FEATURE_SPEC_PATH, "r") as f:
    spec = yaml.safe_load(f)["features"]

# ───── Fill missing features with defaults ─────
def build_full_feature_vector(input_features, spec):
    vector = {}
    for key, config in spec.items():
        if key in input_features and input_features[key] is not None:
            vector[key] = input_features[key]
        else:
            dtype = config.get("type")
            if dtype == "number":
                vector[key] = 0
            elif dtype == "boolean":
                vector[key] = False
            elif dtype == "string":
                vector[key] = ""
            else:
                vector[key] = None
    return vector

filled_features = build_full_feature_vector(features, spec)

# ───── Align with expected features used during training ─────
if hasattr(rf_model, 'feature_names_in_'):
    features_used = list(rf_model.feature_names_in_)
else:
    print(json.dumps({"error": "Random forest model missing feature names"}))
    sys.exit(1)

row = []
for f in features_used:
    val = filled_features.get(f)
    if val is None:
        row.append(0)
    else:
        row.append(val)

X = pd.DataFrame([row], columns=features_used)

# ───── Debug: Feature Vector ─────

# ───── Predict ─────
try:
    rf_pred = rf_model.predict_proba(X)[0][1]
    log_pred = log_model.predict_proba(X)[0][1]
    hybrid_pred = (rf_pred + log_pred) / 2
except Exception as e:
    print(json.dumps({"error": f"Prediction failed: {str(e)}"}))
    sys.exit(1)

# ───── Output ─────
predicted_outcome = "over" if hybrid_pred > 0.5 else "under"
confidence_score = abs(hybrid_pred - 0.5)

print(json.dumps({
    "prop_type": prop_type,
    "random_forest": round(rf_pred, 6),
    "logistic_regression": round(log_pred, 6),
    "hybrid_prediction": round(hybrid_pred, 6),
    "predicted_outcome": predicted_outcome,
    "confidence_score": round(confidence_score, 6)
}))
