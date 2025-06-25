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
from datetime import datetime, timedelta
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, log_loss
from supabase import create_client, Client
import yaml

#
# Load YAML spec
#
with open("model_features.yaml") as f:
    spec = yaml.safe_load(f)

# Decide which feature names to include in your numeric design matrix.
# Here we include all binary/numeric features and any “encoded” fields.
FEATURE_COLS = [
    name
    for name, cfg in spec["features"].items()
    if cfg["type"] in ("binary", "numeric")       
       or name.endswith("_encoded")
]

# static extras (you still need line_diff computed later)
if "line_diff" not in FEATURE_COLS:
    FEATURE_COLS.insert(0, "line_diff")
    
# Supabase & props
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
MODEL_DIR = "backend/models"
PROP_TYPES = [
    "hits", "runs_scored", "rbis", "total_bases", "singles", "doubles",
    "triples", "home_runs", "strikeouts_batting", "walks",
    "hits_runs_rbis", "runs_rbis", "hits_allowed", "earned_runs",
    "walks_allowed", "strikeouts_pitching", "outs_recorded",
]


# ── Helpers ─────────────────────────────────────────────────────────
def fetch_training_data(prop_type: str) -> pd.DataFrame:
    """Pull resolved rows for one prop type in monthly batches."""
    print(f"🔄 Fetching training data for: {prop_type}")
    start_date = datetime(2023, 4, 1)
    end_date = datetime(2024, 12, 31)

    all_rows = []

    current = start_date
    while current <= end_date:
        next_month = current.replace(day=28) + timedelta(days=4)
        next_month = next_month.replace(day=1)
        date_start = current.strftime("%Y-%m-%d")
        date_end = (next_month - timedelta(days=1)).strftime("%Y-%m-%d")

        try:
            resp = (
                supabase.table("model_training_props")
                .select(",".join(FEATURE_COLS + ["result", "prop_value", "prop_source", "outcome"]))
                .eq("prop_type", prop_type)
                .gte("game_date", date_start)
                .lte("game_date", date_end)
                .in_("outcome", ["win", "loss"])
                .limit(50000)
                .execute()
            )
            rows = resp.data or []
            print(f"📅 {date_start} → {date_end} — {len(rows)} rows")
            all_rows.extend(rows)

        except Exception as e:
            print(f"⚠️ Error fetching {date_start} to {date_end}: {e}")

        current = next_month

        df = pd.DataFrame(all_rows)
    if df.empty:
        return df

    # Derived fields
    if "line_diff" not in df.columns and "result" in df.columns and "prop_value" in df.columns:
        df["line_diff"] = df["result"] - df["prop_value"]

    if "opponent_encoded" not in df.columns and "opponent" in df.columns:
        df["opponent_encoded"] = df["opponent"].astype("category").cat.codes

    # Keep only rows with essential fields present
    essential_fields = ["result", "prop_value", "outcome", "prop_source"]
    df = df.dropna(subset=essential_fields)

    # Log sparsity of optional features (do not drop)
    available_features = [col for col in FEATURE_COLS if col in df.columns]
    missing_report = df[available_features].isnull().mean().sort_values(ascending=False)
    missing_nonzero = missing_report[missing_report > 0]

    if not missing_nonzero.empty:
        print(f"🔍 Missing data ratio for {len(df)} valid rows (optional features only):")
        print(missing_nonzero)

    # Derive binary classification target
    df["target"] = (df["outcome"] == "win").astype(int)

    return df

def compute_sample_weights(df: pd.DataFrame) -> pd.Series:
    """100 × weight for user_added, 1 × for mlb_api."""
    return df["prop_source"].apply(lambda s: 100 if s == "user_added" else 1)


def train_and_save(df: pd.DataFrame, prop_type: str) -> None:
    if df.empty:
        print(f"⚠️  No data for {prop_type} — skipping.")
        return

    # ── Expand one-hot categorical features ──
    cat_feats = [
        name for name, cfg in spec["features"].items()
        if cfg.get("transform") == "one_hot"
    ]
    if cat_feats:
        df = pd.get_dummies(df, columns=cat_feats, drop_first=True)
        expanded = [c for c in df.columns if any(c.startswith(f"{feat}_") for feat in cat_feats)]
        final_features = [f for f in FEATURE_COLS if f not in cat_feats] + expanded
    else:
        final_features = FEATURE_COLS

    X = df[final_features]
    y = df["target"]
    weights = compute_sample_weights(df)

    print(f"\n📊 Training {prop_type.upper()} — {len(df)} rows")
    print(f"   ✅ Features used: {len(final_features)}")
    print(f"   ✅ Class balance: {sum(y==1)} wins / {sum(y==0)} losses")
    print(f"   ⚖️  Sample weights → max: {weights.max()}, min: {weights.min()}")

    model = LogisticRegression(max_iter=1000)
    model.fit(X, y, sample_weight=weights)

    y_pred = model.predict(X)
    y_proba = model.predict_proba(X)
    print(classification_report(y, y_pred, digits=3))
    print("   🧮 Log Loss:", round(log_loss(y, y_proba), 4))

    os.makedirs(MODEL_DIR, exist_ok=True)
    path = os.path.join(MODEL_DIR, f"{prop_type}_model.pkl")
    joblib.dump(model, path)
    print(f"✅ Saved: {path}")


# ── Main loop ───────────────────────────────────────────────────────
def main() -> None:
    for prop_type in PROP_TYPES:
        df = fetch_training_data(prop_type)
        train_and_save(df, prop_type)


if __name__ == "__main__":
    main()
