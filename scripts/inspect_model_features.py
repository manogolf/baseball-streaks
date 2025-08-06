# File: scripts/inspect_model_features.py

import joblib
import os

MODEL_DIR = "backend/models"  # or wherever your compressed models live
PROP_TYPES = [
    "hits", "singles", "home_runs", "rbis", "strikeouts_batting",
    "walks", "total_bases", "hits_runs_rbis", "stolen_bases",
    "strikeouts_pitching", "walks_allowed", "earned_runs", "hits_allowed"
]

def inspect_features(prop_type):
    for model_kind in ["random_forest", "logistic_regression"]:
        path = f"{MODEL_DIR}/{prop_type}/{prop_type}_{model_kind}_compressed.pkl"
        if not os.path.exists(path):
            print(f"❌ Missing: {path}")
            continue
        try:
            model = joblib.load(path)
            features = getattr(model, "feature_names_in_", None)
            if features is not None:
                print(f"\n📦 {prop_type} - {model_kind}:")
                for i, feat in enumerate(features):
                    print(f"  {i+1:2d}. {feat}")
            else:
                print(f"⚠️  {prop_type} - {model_kind} has no feature_names_in_ attribute")
        except Exception as e:
            print(f"❌ Failed to load {path}: {e}")

if __name__ == "__main__":
    for prop in PROP_TYPES:
        inspect_features(prop)
