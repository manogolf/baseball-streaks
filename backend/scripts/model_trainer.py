import os
import pandas as pd
import joblib
from io import BytesIO
from dotenv import load_dotenv
from supabase import create_client
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score

load_dotenv()

# 🔐 Connect to Supabase
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_SERVICE_ROLE_KEY")
)

def fetch_data(prop_type):
    def fetch_subset(outcome):
        res = supabase.table("model_training_props") \
            .select("*") \
            .eq("prop_type", prop_type) \
            .eq("outcome", outcome) \
            .limit(500) \
            .execute()
        return pd.DataFrame(res.data)

    win_df = fetch_subset("win")
    loss_df = fetch_subset("loss")

    if win_df.empty or loss_df.empty:
        print(f"Outcome value counts: win={len(win_df)}, loss={len(loss_df)}")
        raise ValueError(f"Not enough outcome variation to train {prop_type}")

    min_len = min(len(win_df), len(loss_df))
    df = pd.concat([win_df.sample(min_len), loss_df.sample(min_len)], ignore_index=True)
    df["outcome"] = df["outcome"].str.lower().str.strip()
    return df

def upload_model_to_supabase_from_memory(filename, model):
    buffer = BytesIO()
    joblib.dump(model, buffer)
    buffer.seek(0)

    response = supabase.storage.from_("2025.05.23.mlb-models").upload(
        path=filename,
        file=buffer.read(),
        file_options={"content-type": "application/octet-stream", "upsert": True},
    )

    if hasattr(response, "error") and response.error:
        print(f"❌ Upload error for {filename}: {response.error.message}")
    else:
        print(f"📤 Uploaded {filename} to Supabase from memory.")

def train_and_save_model(prop_type):
    df = fetch_data(prop_type)
    if df.empty:
        raise ValueError(f"No training data found for: {prop_type}")

    # ✅ Feature engineering
    df["line_diff"] = (
        pd.to_numeric(df["rolling_result_avg_7"], errors="coerce").fillna(0)
        - pd.to_numeric(df["prop_value"], errors="coerce").fillna(0)
    )
    df["opponent_encoded"] = pd.to_numeric(df["opponent_avg_win_rate"], errors="coerce").fillna(0.5)
    df["hit_streak"] = pd.to_numeric(df["hit_streak"], errors="coerce").fillna(0)
    df["win_streak"] = pd.to_numeric(df["win_streak"], errors="coerce").fillna(0)
    df["is_home"] = pd.to_numeric(df["is_home"], errors="coerce").fillna(0)

    feature_cols = ["line_diff", "hit_streak", "win_streak", "is_home", "opponent_encoded"]
    df.dropna(subset=feature_cols + ["outcome"], inplace=True)

    X = df[feature_cols]
    y = df["outcome"].map({"win": 1, "loss": 0})

    if y.nunique() < 2:
        raise ValueError(f"Not enough outcome variation to train {prop_type}")

    print(f"📦 {prop_type} training rows: {len(df)} (win/loss)")

    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X, y)

    y_pred = model.predict(X)
    acc = accuracy_score(y, y_pred)
    print(f"✅ {prop_type} model accuracy: {acc:.3f}")

    importances = model.feature_importances_
    print("📊 Feature importances:", dict(zip(feature_cols, importances)))

    # ✅ Upload to Supabase from memory
    model_filename = f"{prop_type}_model.pkl"
    upload_model_to_supabase_from_memory(model_filename, model)
