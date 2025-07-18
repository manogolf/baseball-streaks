#  backend/scripts/modeling/build_feature_vector.py

import pandas as pd
from supabase import create_client
import os
from dotenv import load_dotenv
import yaml
from transform_features import transform_features

# Load environment variables
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ───── Load Feature Spec from YAML ─────
def load_feature_spec():
    with open("model_features.yaml", "r") as f:
        return yaml.safe_load(f)

def build_feature_vector(row):
    player_id = row.get("player_id")
    game_id = row.get("game_id")
    team = row.get("team")
    prop_type = row.get("prop_type")

    if not (player_id and game_id and team):
        raise ValueError("Missing required fields to build feature vector")

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
    feature_data.update({f"bvp_{k}": v for k, v in bvp.items() if k not in ["id", "batter_id", "game_id"]})

    # ───── Join Player Stats ─────
    stats_resp = (
        supabase.table("player_stats")
        .select("*")
        .eq("player_id", player_id)
        .eq("game_id", game_id)
        .execute()
    )
    stats = stats_resp.data[0] if stats_resp.data else {}

    batter_fields = {
        "hits": "player_hits",
        "total_bases": "player_total_bases",
        "rbis": "player_rbis",
        "runs": "player_runs",
        "home_runs": "player_home_runs",
        "singles": "player_singles",
        "doubles": "player_doubles",
        "triples": "player_triples",
        "strikeouts_batting": "player_strikeouts",
        "walks": "player_walks",
        "stolen_bases": "player_stolen_bases",
    }

    pitcher_fields = {
        "strikeouts_pitching": "pitcher_strikeouts",
        "walks_allowed": "pitcher_walks_allowed",
        "hits_allowed": "pitcher_hits_allowed",
        "outs_recorded": "pitcher_outs_recorded",
        "earned_runs": "pitcher_earned_runs",
    }

    for old_key, new_key in {**batter_fields, **pitcher_fields}.items():
        if old_key in stats:
            feature_data[new_key] = stats[old_key]

    # ───── Join Player Derived Stats ─────
    derived_resp = (
        supabase.table("player_derived_stats")
        .select("*")
        .eq("player_id", player_id)
        .eq("game_id", game_id)
        .execute()
    )
    derived = derived_resp.data[0] if derived_resp.data else {}
    feature_data.update(derived)

    # ───── Transform to model-ready features ─────
    vector = transform_features(feature_data)
    return vector
