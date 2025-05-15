# backend/scripts/train_strikeouts_pitching.py

import os
import json
from pathlib import Path
from dotenv import load_dotenv
from model_trainer import train_and_save_model

load_dotenv()

# Log path info just in case
print(f"📁 Current directory: {os.getcwd()}")

# Optional: validate the model directory
Path("models").mkdir(exist_ok=True)

# Run training for only this prop
try:
    print("🔁 Training model for: strikeouts_pitching")
    train_and_save_model("strikeouts_pitching")
    print("✅ strikeouts_pitching model trained and saved.")
except Exception as e:
    print(f"❌ Error training strikeouts_pitching: {e}")
