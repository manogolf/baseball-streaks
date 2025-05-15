# backend/scripts/retrain_all_models.py

import os
import json
from pathlib import Path
# New
from model_trainer import train_and_save_model


# 🔁 Load canonical prop type keys from prop_types.json
with open(os.path.join(os.path.dirname(__file__), '../app/prop_types.json')) as f:
    PROP_MODEL_MAP = json.load(f)

prop_types = list(PROP_MODEL_MAP.keys())  # ['hits', 'home_runs', ...]

def main():
    print("🚀 Starting full model retrain for all prop types...")

    Path("models").mkdir(exist_ok=True)  # ensure model dir exists

    for prop in prop_types:
        print(f"🔁 Training model for: {prop}")
        try:
            train_and_save_model(prop)
        except Exception as e:
            print(f"❌ Failed training {prop}: {e}")

    print("✅ All models retrained.")

if __name__ == "__main__":
    main()
