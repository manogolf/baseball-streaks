"""
retrain_all_models.py

This script trains one logistic regression model per MLB prop type using all available
historical data from the 'model_training_props' table in Supabase.

Key Features:
- Uses all resolved props (user-added and mlb_api).
- Applies sample weighting: user_added props count 100×, mlb_api count 1×.
- Uses consistent, unified feature set across all models.
- Saves trained models as .pkl files to backend/models/ for downstream prediction use.

Typical use case:
This script runs on a recurring schedule (e.g., daily via cron) to keep models updated
as new props are resolved. It complements the recent-form random forest trainer by
providing deeper historical generalization.

Do not confuse with:
- model_trainer.py → trains recent-form Random Forest models on balanced samples.
- backfill_training_props.py → populates training data from resolved props.
"""

import os
import pandas as pd
import joblib
from sklearn.linear_model import LogisticRegression
from supabase import create_client, Client

# ── Supabase connection ─────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Constants ───────────────────────────────────────────────────────
MODEL_DIR = "backend/models"
PROP_TYPES = [
    "hits", "runs_scored", "rbis", "total_bases", "singles", "doubles",
    "triples", "home_runs", "strikeouts_batting", "walks",
    "hits_runs_rbis", "runs_rbis", "hits_allowed", "earned_runs",
    "walks_allowed", "strikeouts_pitching", "outs_recorded", "at_bats",
]

FEATURE_COLS = [
    "line_diff",
    "hit_streak",
    "win_streak",
    "is_home",
    "opponent_encoded",
    "opponent_avg_win_rate",
]

# ── Helpers ─────────────────────────────────────────────────────────
def fetch_training_data(prop_type: str) -> pd.DataFrame:
    """Pull all resolved rows for one prop type."""
    resp = (
        supabase.table("model_training_props")
        .select("*")
        .eq("prop_type", prop_type)
        .in_("status", ["win", "loss"])
        .execute()
    )
    df = pd.DataFrame(resp.data or [])
    if df.empty:
        return df

    # Ensure required base columns exist
    if "line_diff" not in df.columns and {"result", "prop_value"} <= df.columns:
        df["line_diff"] = df["result"] - df["prop_value"]

    if "opponent_encoded" not in df.columns and "opponent" in df.columns:
        df["opponent_encoded"] = df["opponent"].astype("category").cat.codes

    df = df.dropna(subset=FEATURE_COLS + ["result", "prop_source"])
    df["target"] = (df["result"] == "win").astype(int)
    return df


def compute_sample_weights(df: pd.DataFrame) -> pd.Series:
    """100 × weight for user_added, 1 × for mlb_api."""
    return df["prop_source"].apply(lambda s: 100 if s == "user_added" else 1)


def train_and_save(df: pd.DataFrame, prop_type: str) -> None:
    if df.empty:
        print(f"⚠️  No data for {prop_type} — skipping.")
        return

    X = df[FEATURE_COLS]
    y = df["target"]
    weights = compute_sample_weights(df)

    model = LogisticRegression(max_iter=1000)
    model.fit(X, y, sample_weight=weights)

    os.makedirs(MODEL_DIR, exist_ok=True)
    path = os.path.join(MODEL_DIR, f"{prop_type}_model.pkl")
    joblib.dump(model, path)
    print(f"✅  Trained {prop_type} — saved to {path}")


# ── Main loop ───────────────────────────────────────────────────────
def main() -> None:
    for prop_type in PROP_TYPES:
        df = fetch_training_data(prop_type)
        train_and_save(df, prop_type)


if __name__ == "__main__":
    main()
