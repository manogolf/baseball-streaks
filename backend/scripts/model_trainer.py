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
        res = supabase.table("recent_model_training_props") \
            .select("*") \
            .eq("prop_type", prop_type) \
            .eq("outcome", outcome) \
            .order("game_date", desc=True) \
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

    if not df.empty:
        source_counts = df["source"].value_counts(dropna=False).to_dict()
        print(f"📊 Source breakdown for {prop_type}: {source_counts}")
        df["game_date"] = pd.to_datetime(df["game_date"], errors="coerce")
        latest_date = df["game_date"].max()
        print(f"📅 Latest game_date in training data for {prop_type}: {latest_date.date() if pd.notnull(latest_date) else 'N/A'}")

    return df



def upload_model_to_supabase_from_memory(filename, model):
    buffer = BytesIO()
    joblib.dump(model, buffer)
    buffer.seek(0)

    response = supabase.storage.from_("models").upload(
        path=filename,
        file=buffer.read(),
        file_options={"content-type": "application/octet-stream", "upsert": "true"},
    )

    if hasattr(response, "error") and response.error:
        print(f"❌ Upload error for {filename}: {response.error.message}")
    else:
        print(f"📤 Uploaded {filename} to Supabase from memory.")

def train_and_save_model(prop_type):
    df = fetch_data(prop_type)

    # Compute line_diff if missing
    if "line_diff" not in df.columns:
        if "result" in df.columns and "prop_value" in df.columns:
            df["line_diff"] = df["result"] - df["prop_value"]
        else:
            raise ValueError("Missing 'result' or 'prop_value' to compute 'line_diff'")

    # Encode opponent
    if "opponent_encoded" not in df.columns and "opponent" in df.columns:
        df["opponent_encoded"] = df["opponent"].astype("category").cat.codes

    if df.empty:
        raise ValueError(f"No training data found for: {prop_type}")

    feature_cols = ["line_diff", "hit_streak", "win_streak", "is_home", "opponent_avg_win_rate", "opponent_encoded"]
    df.dropna(subset=feature_cols + ["outcome"], inplace=True)
    X = df[feature_cols]




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
