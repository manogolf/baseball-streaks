"""
model_trainer.py

Trains recent-form Random-Forest models for each MLB prop type.

Key points
----------
• Pulls up to 1 000 of the most-recent resolved rows (500 wins + 500 losses) per prop
  from the `model_training_props` base table in Supabase.  
• Balances the training set (50 % wins / 50 % losses).  
• Uses a unified feature set: line_diff, hit & win streaks, home/away, opponent features.  
• Uploads each trained `.pkl` model to Supabase Storage (`models` bucket).  
• Intended to run several times per day (cron) to capture short-term form.
"""

import os
from io import BytesIO

import joblib
import pandas as pd
from dotenv import load_dotenv
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score
from supabase import create_client

# ── env + Supabase ──────────────────────────────────────────────────
load_dotenv()
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_ROLE_KEY"),
)

# ── constants ───────────────────────────────────────────────────────
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
    "opponent_avg_win_rate",
    "opponent_encoded",
]

# ── helpers ─────────────────────────────────────────────────────────
def fetch_data(prop_type: str) -> pd.DataFrame:
    """Return a balanced (win/loss) recent sample for one prop_type."""
    def pull(outcome: str) -> pd.DataFrame:
        res = (
            supabase.table("model_training_props")
            .select("*")
            .eq("prop_type", prop_type)
            .eq("outcome", outcome)
            .order("game_date", desc=True)
            .limit(500)
            .execute()
        )
        return pd.DataFrame(res.data)

    win_df  = pull("win")
    loss_df = pull("loss")

    if win_df.empty or loss_df.empty:
        raise ValueError(f"Not enough outcome variety for {prop_type}")

    n = min(len(win_df), len(loss_df))
    df = pd.concat([win_df.sample(n), loss_df.sample(n)], ignore_index=True)

    # clean + metadata
    df["outcome"] = df["outcome"].str.strip().str.lower()
    return df


def upload_model_to_supabase_from_memory(filename: str, model) -> None:
    """Upload a pickled model to Supabase Storage (models bucket)."""
    buf = BytesIO()
    joblib.dump(model, buf)
    buf.seek(0)

    resp = supabase.storage.from_("models").upload(
        path=filename,
        file=buf.read(),
        file_options={"content-type": "application/octet-stream", "upsert": "true"},
    )
    if hasattr(resp, "error") and resp.error:
        print(f"❌ Upload error for {filename}: {resp.error.message}")
    else:
        print(f"📤 Uploaded {filename} to Supabase.")


def train_and_save_model(prop_type: str) -> None:
    df = fetch_data(prop_type)

    # derive line_diff if missing
    if "line_diff" not in df.columns:
        if {"result", "prop_value"} <= df.columns:
            df["line_diff"] = df["result"] - df["prop_value"]
        else:
            raise ValueError("Missing result or prop_value to compute line_diff")

    # encode opponent if absent
    if "opponent_encoded" not in df.columns and "opponent" in df.columns:
        df["opponent_encoded"] = df["opponent"].astype("category").cat.codes

    # drop incomplete rows
    df.dropna(subset=FEATURE_COLS + ["outcome"], inplace=True)
    if df.empty:
        raise ValueError(f"No usable rows for {prop_type}")

    X = df[FEATURE_COLS]
    y = df["outcome"].map({"win": 1, "loss": 0})

    if y.nunique() < 2:
        raise ValueError(f"Outcome imbalance for {prop_type}")

    print(f"📦 {prop_type}: {len(df)} rows (balanced)")

    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X, y)

    print(
        f"✅ {prop_type} RF accuracy: "
        f"{accuracy_score(y, model.predict(X)):.3f}"
    )
    print(
        "📊 Feature importances:",
        dict(zip(FEATURE_COLS, model.feature_importances_)),
    )

    upload_model_to_supabase_from_memory(f"{prop_type}_model.pkl", model)


# ── main loop ───────────────────────────────────────────────────────
def main() -> None:
    print("🚀 Starting recent-form Random-Forest training…")
    for prop in PROP_TYPES:
        try:
            train_and_save_model(prop)
        except ValueError as e:
            print(f"⚠️  {e}")

    print("🎉 All recent-form models updated.")


if __name__ == "__main__":
    main()
