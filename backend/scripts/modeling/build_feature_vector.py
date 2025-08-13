import pandas as pd
import numpy as np
from supabase import create_client
import os
import json
from dotenv import load_dotenv
import yaml
from pathlib import Path
from backend.scripts.modeling.transform_features import transform_features


FEATURE_META_PATH = os.getenv("FEATURE_META_PATH", "/var/data/models/feature_metadata.json")

def _is_missing(v) -> bool:
    if v is None: return True
    if isinstance(v, str) and v.strip() == "": return True
    try:
        return bool(pd.isna(v))
    except Exception:
        return False

def expected_feature_columns(prop_type: str | None):
    """Return canonical feature list (YAML first, then JSON), or None."""
    # Try YAML (your existing spec)
    try:
        spec = load_feature_spec()
        if isinstance(spec, dict):
            if prop_type and prop_type in spec:
                v = spec[prop_type]
                if isinstance(v, dict) and "columns" in v and isinstance(v["columns"], list):
                    return list(v["columns"])
            if "columns" in spec and isinstance(spec["columns"], list):
                return list(spec["columns"])
    except Exception:
        pass
    # Try JSON metadata bundled with models
    try:
        if os.path.exists(FEATURE_META_PATH):
            with open(FEATURE_META_PATH, "r") as f:
                meta = json.load(f)
            if isinstance(meta, dict):
                if prop_type and prop_type in meta:
                    v = meta[prop_type]
                    if isinstance(v, dict) and "columns" in v: return list(v["columns"])
                    if isinstance(v, list): return list(v)
                if "columns" in meta and isinstance(meta["columns"], list):
                    return list(meta["columns"])
    except Exception:
        pass
    return None


def _as_scalar(v):
    """Return a plain Python scalar from Series/DataFrame/NumPy/list-of-1."""
    if isinstance(v, pd.Series):
        return _as_scalar(v.iloc[0] if not v.empty else None)
    if isinstance(v, pd.DataFrame):
        return _as_scalar(v.iloc[0, 0] if not v.empty else None)
    if isinstance(v, (list, tuple)) and len(v) == 1:
        return _as_scalar(v[0])
    if isinstance(v, np.generic):
        return v.item()
    return v

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

# --- in fetch_missing_fields(...) ---
def fetch_missing_fields(player_id, game_id, team):
    # pull the whole row; we'll pick what we need upstream
    response = supabase.from_("model_training_props") \
        .select("*") \
        .eq("player_id", player_id) \
        .eq("game_id", game_id) \
        .eq("team", team) \
        .limit(1) \
        .execute()

    if response.data and isinstance(response.data, list) and response.data:
        return response.data[0]
    return {}

# ───── Load Feature Spec from YAML ─────
def load_feature_spec():
    with open("model_features.yaml", "r") as f:
        return yaml.safe_load(f)

def build_feature_vector(data, debug: bool = False):
    """
    Accepts a dict or DataFrame (one row), ensures scalars for ids/team,
    fetches any missing fields, then delegates to transform_features(...).

    Returns: (X, y_or_None)
    """
    # ── normalize input to a one-row DataFrame
    if isinstance(data, dict):
        df = pd.DataFrame([data])
    elif isinstance(data, pd.DataFrame):
        df = data.copy()
    else:
        df = pd.DataFrame(data)

    if df.empty:
        if debug: print("⚠️ build_feature_vector: empty input")
        return pd.DataFrame(), None

    # Use a dict row for easy scalar access & mutation
    row = df.iloc[0].to_dict()

    # ── scalars
    player_id = _as_scalar(row.get("player_id"))
    game_id   = _as_scalar(row.get("game_id"))
    team      = _as_scalar(row.get("team"))

    # ── coerce ids/types for DB lookups
    try:
        player_id = int(player_id) if player_id not in (None, "", np.nan) else None
    except Exception:
        pass
    try:
        game_id = int(game_id) if game_id not in (None, "", np.nan) else None
    except Exception:
        pass
    team = str(team) if team not in (None, "", np.nan) else None

    # ── pull DB row and MERGE it wholesale (not just 'missing_keys')
    fetched = {}
    if player_id is not None and game_id is not None and team is not None:
        try:
            fetched = fetch_missing_fields(player_id, game_id, team) or {}
        except Exception as e:
            if debug: print(f"⚠️ fetch_missing_fields failed: {e}")
            fetched = {}

    # Normalize fetched values to scalars and merge over the input row
    if fetched:
        fetched = {k: _as_scalar(v) for k, v in fetched.items()}
        row.update(fetched)

    # Safety: ensure ids/team present
    if any(v in (None, "", np.nan) for v in (row.get("player_id"), row.get("game_id"), row.get("team"))):
        if debug: print("🚫 Required ids/team missing after fetch")
        return pd.DataFrame(), None

    # Rebuild single-row DataFrame for transformation
    one = pd.DataFrame([row])

    # ── delegate to transformer
    try:
        from .transform_features import transform_features  # package import
    except Exception:
        from transform_features import transform_features   # local fallback

    def _is_all_zero(df):
        try:
            return bool((df.fillna(0) == 0).to_numpy().all())
        except Exception:
            return False

    try:
        out = transform_features(one, debug=debug)
    except TypeError:
        out = transform_features(one)

    # Normalize output to (X, y_or_None)
    if isinstance(out, tuple) and len(out) >= 1:
        X = out[0]
        y = out[1] if len(out) > 1 else None
    else:
        X, y = out, None

    # ⛑️ Fallback: if transformer returns empty or all zeros, use the raw row;
    # the caller will align to the model's schema and coerce numerics.
    if not isinstance(X, pd.DataFrame):
        X = pd.DataFrame(X) if X is not None else pd.DataFrame()
    if X.empty or _is_all_zero(X):
        if debug: print("🛟 Fallback to raw row features (pre-alignment)")
        X = one.copy()

    return X, y

if __name__ == "__main__":
    pass  # Safe no-op to satisfy the interpreter

