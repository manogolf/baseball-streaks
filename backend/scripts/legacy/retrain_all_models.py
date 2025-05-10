# backend/scripts/retrain_all_models.py and do it daily

from pathlib import Path
from train_generic_model import train_and_save_model

ALL_PROP_TYPES = [
    "Hits", "Runs Scored", "Earned Runs", "Home Runs", "RBI",
    "Strikeouts (Pitching)", "Strikeouts (Batting)", "Walks", "Hits Allowed",
    "Outs Recorded", "Total Bases", "Stolen Bases", "Singles", "Doubles", "Triples",
    "Walks Issued", "Pitching Outs", "Total Pitches", "Batting Average"
]

def main():
    print("🚀 Starting full model retrain for all 19 prop types...")

    Path("models").mkdir(exist_ok=True)

    for prop in ALL_PROP_TYPES:
        print(f"🔁 Training model for: {prop}")
        try:
            train_and_save_model(prop)
        except Exception as e:
            print(f"❌ Failed training {prop}: {e}")

    print("✅ All models retrained.")

if __name__ == "__main__":
    main()

