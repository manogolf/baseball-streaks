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
    response = (
        supabase
        .table("model_training_props")  # <= v2 style
        .select(",".join(["player_id", "game_id", "team"] + MODEL_TRAINING_PROPS_FIELDS))
        .eq("player_id", player_id)
        .eq("game_id", game_id)
        .eq("team", team)
        .limit(1)
        .execute()
    )
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

    # ── pull scalars
    player_id = _as_scalar(row.get("player_id"))
    game_id   = _as_scalar(row.get("game_id"))
    team      = _as_scalar(row.get("team"))
    
    # coerce types for DB queries
    try:
        player_id = int(player_id) if not _is_missing(player_id) else None
    except Exception:
        pass
    try:
        game_id = int(game_id) if not _is_missing(game_id) else None
    except Exception:
        pass
    team = str(team) if not _is_missing(team) else None

    # basic presence
    missing_basic = []
    if _is_missing(player_id): missing_basic.append("player_id")
    if _is_missing(game_id):   missing_basic.append("game_id")
    if _is_missing(team):      missing_basic.append("team")

    # extended required fields
    try:
        req_fields = list(MODEL_TRAINING_PROPS_FIELDS)
    except NameError:
        req_fields = ["player_id", "game_id", "team"]

    missing_keys = [k for k in req_fields if _is_missing(row.get(k))]
    if debug:
        print(f"🔑 Missing keys: {missing_keys}")

    # ── fill from DB if anything is missing
    if missing_basic or missing_keys:
        try:
            fetched = fetch_missing_fields(player_id, game_id, team)  # your existing helper
        except Exception as e:
            if debug: print(f"⚠️ fetch_missing_fields failed: {e}")
            fetched = {}

        if debug:
            print(f"📦 Fetched fields: {fetched}")

        # update core ids/team if the DB returns them
        if fetched:
            player_id = _as_scalar(fetched.get("player_id", player_id))
            game_id   = _as_scalar(fetched.get("game_id", game_id))
            team      = _as_scalar(fetched.get("team", team))
            # write back to row
            row["player_id"] = player_id
            row["game_id"]   = game_id
            row["team"]      = team

            # fill other missing fields the model expects
            for key in missing_keys:
                if key in fetched and fetched[key] is not None:
                    row[key] = _as_scalar(fetched[key])

        # final safety: ensure ids/team are present
        if any(_is_missing(v) for v in (player_id, game_id, team)):
            if debug: print("🚫 Required ids/team still missing after fetch")
            return pd.DataFrame(), None
        # Rebuild single-row DataFrame for transformation
        one = pd.DataFrame([row])

    # ── delegate to your transformer
    # it might be defined as transform_features(df) or transform_features(df, debug=..)
    try:
        from .transform_features import transform_features  # package import
    except Exception:
        from transform_features import transform_features  # direct import fallback

    try:
        out = transform_features(one, debug=debug)
    except TypeError:
        out = transform_features(one)

    # Normalize output to (X, y_or_None)
    if isinstance(out, tuple) and len(out) >= 1:
        X = out[0]; y = out[1] if len(out) > 1 else None
    else:
        X, y = out, None

    # Coerce X to a 1-row DataFrame (handles dict/Series/ndarray)
    if isinstance(X, pd.DataFrame):
        pass
    elif isinstance(X, pd.Series):
        X = X.to_frame().T
    elif isinstance(X, dict):
        X = pd.DataFrame([X])
    elif isinstance(X, np.ndarray):
        X = pd.DataFrame([X]) if X.ndim == 1 else pd.DataFrame(X)
    else:
        X = pd.DataFrame([X])

    # numeric safety + NaNs/inf -> 0
    for c in X.columns:
        if X[c].dtype == object:
            try: X[c] = pd.to_numeric(X[c], errors="coerce")
            except Exception: pass
    X = X.replace([np.inf, -np.inf], 0).fillna(0)

    if getattr(X, "empty", True):
        return pd.DataFrame(), y

    return X, y

if __name__ == "__main__":
    pass  # Safe no-op to satisfy the interpreter

