import pandas as pd
from supabase import create_client
import os
from dotenv import load_dotenv
import yaml
from pathlib import Path
from transform_features import transform_features

# Load environment variables
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

#------Load Game Context------
MODEL_TRAINING_PROPS_FIELDS = [
    "is_home",
    "opponent",
    "opponent_encoded",
    "game_day_of_week",
    "time_of_day_bucket",
    "game_time",
    "streak_count",
    "hit_streak",
    "win_streak",
    "rolling_result_avg_7",
    "line",
    "line_diff",
    "prop_source"
]

def fetch_missing_fields(player_id, game_id, team):
    response = supabase.from_("model_training_props") \
        .select(",".join(["player_id", "game_id", "team"] + MODEL_TRAINING_PROPS_FIELDS)) \
        .eq("player_id", player_id) \
        .eq("game_id", game_id) \
        .eq("team", team) \
        .limit(1) \
        .execute()

    if response.data and isinstance(response.data, list) and response.data:
        return response.data[0]  # 👈 Return the single row directly
    return {}

# ───── Load Feature Spec from YAML ─────
def load_feature_spec():
    with open("model_features.yaml", "r") as f:
        return yaml.safe_load(f)

def build_feature_vector(row, debug=False):
    player_id = row.get("player_id")
    game_id = row.get("game_id")
    team = row.get("team")

    print(f"🔍 Fetching missing fields for player_id={player_id}, game_id={game_id}, team={team}")

    if not (player_id and game_id and team):
        raise ValueError("Missing required fields to build feature vector")

    # ───── Fill missing fields by querying model_training_props ─────
    missing_keys = [k for k in MODEL_TRAINING_PROPS_FIELDS if k not in row or row[k] is None]
    print(f"🔑 Missing keys: {missing_keys}")

    fetched = fetch_missing_fields(player_id, game_id, team)
    print(f"📦 Fetched fields: {fetched}")

    for key in missing_keys:
        if key in fetched and fetched[key] is not None:
            row[key] = fetched[key]

    print(f"✅ Row after merge: { {k: row.get(k) for k in MODEL_TRAINING_PROPS_FIELDS} }")


    # Load YAML spec for strict feature auditing
    feature_spec = load_feature_spec().get("features", {})

    # Start with the row itself
    feature_data = dict(row)

    # ───── Join BvP Stats ─────
    bvp_resp = (
        supabase.table("bvp_stats")
        .select("*")
        .eq("batter_id", player_id)
        .eq("game_id", game_id)
        .execute()
    )
    bvp = bvp_resp.data[0] if bvp_resp.data else {}

    for field in feature_spec:
        if field.startswith("bvp_"):
            feature_data[field] = bvp.get(field, None)

    # ───── Join Player Stats ─────
    stats_resp = (
        supabase.table("player_stats")
        .select("*")
        .eq("player_id", player_id)
        .eq("game_id", game_id)
        .execute()
    )
    stats = stats_resp.data[0] if stats_resp.data else {}

    # ───── Join Player Derived Stats ─────
    derived_resp = (
        supabase.table("player_derived_stats")
        .select("*")
        .eq("player_id", player_id)
        .eq("game_id", game_id)
        .execute()
    )
    derived = derived_resp.data[0] if derived_resp.data else {}

    for field in feature_spec:
        if field.startswith("d7_") or field.startswith("d15_") or field.startswith("d30_"):
            feature_data[field] = derived.get(field, None)

    # ───── One-hot encode streak_type ─────
    streak_type = feature_data.pop("streak_type", None)
    for val in ["hot", "cold", "neutral"]:
        feature_data[f"streak_type_{val}"] = int(streak_type == val)

    # ───── Fill in any remaining missing spec fields ─────
    for field in feature_spec:
        if field not in feature_data:
            feature_data[field] = None

    # ───── Diagnostic Logging (Optional) ─────
    missing_fields = [f for f in feature_spec if feature_data.get(f) is None]
    if missing_fields:
       print(f"⚠️ Missing fields for player {player_id}, game {game_id}: {missing_fields}")

    # ───── Final feature transformation and return ─────
    vector = transform_features(feature_data)
    return vector

if __name__ == "__main__":
    pass  # Safe no-op to satisfy the interpreter

