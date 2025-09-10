# backend/app/routes/api/props.py

from __future__ import annotations

import os
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request

# Repo-local imports (run server with: uvicorn app.api_server:app --reload --port 8001 --app-dir backend)
from scripts.shared.supabase_utils import supabase
from app.config import COMMIT_TOKEN_SECRET, COMMIT_TOKEN_TTL
from app.security.commit_token import verify_commit_token
from scripts.shared.prop_utils import (
    get_team_abbr_from_team_id,
    get_latest_team_for_player,
)

try:
    from postgrest.exceptions import APIError as PostgrestAPIError
except Exception:  # pragma: no cover
    PostgrestAPIError = Exception

log = logging.getLogger(__name__)
router = APIRouter()
TABLE = "player_props"


# --- helper: resolve name by player_id from player_ids table ---
def _get_player_name_by_id(pid: int | str) -> Optional[str]:
    try:
        res = (
            supabase.from_("player_ids")
            .select("player_name")
            .eq("player_id", str(pid))
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", []) or []
        if rows:
            return rows[0].get("player_name")
    except Exception:
        pass
    return None


# --- duplicate check: mirror DB UNIQUE(prop_source, player_id, game_id, prop_type, prop_value) ---
def _dup_exists(
    *,
    prop_source: str,
    player_id: int,
    game_id: int,
    prop_type: str,
    prop_value: float,
) -> bool:
    key: Dict[str, Any] = {
        "prop_source": prop_source,
        "player_id": int(player_id),     # BIGINT in schema
        "game_id": int(game_id),         # BIGINT in schema
        "prop_type": prop_type,
        "prop_value": float(prop_value), # keep exact value (UI .5 steps)
    }
    res = supabase.from_(TABLE).select("id").match(key).limit(1).execute()
    rows = getattr(res, "data", []) or []
    if os.getenv("DEBUG_DEDUP") == "1":
        log.info("[DEDUP] key=%s matched=%s", key, rows[:1])
    return bool(rows)


@router.post("/props/add")
async def add_prop(req: Request):
    """
    Save a user-added prop using a commit_token minted by /api/predict.
    - Enforces DB unique key exactly: (prop_source, player_id, game_id, prop_type, prop_value)
    - Requires game_id; no fallback to date
    - Keeps prop_value as-is (UI provides 0.5, 1.5, 2.5 …)
    """
    body = await req.json()
    token = body.get("commit_token")
    if not token:
        raise HTTPException(status_code=400, detail="commit_token required")

    # Verify token + unpack payload
    try:
        data = verify_commit_token(
            token,
            ttl_seconds=COMMIT_TOKEN_TTL,
            secret=COMMIT_TOKEN_SECRET,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid commit_token: {e}")

    # /api/predict puts the prepared fields under "features"
    features = data.get("features", data) if isinstance(data, dict) else {}
    if not isinstance(features, dict):
        raise HTTPException(status_code=400, detail="Malformed token payload")

    # Normalize naming: accept "line" as alias for prop_value
    if "prop_value" not in features and "line" in features:
        features["prop_value"] = features["line"]

    # Required: note game_id is mandatory per schema
    required = ("player_id", "team_id", "game_id", "game_date", "prop_type", "prop_value")
    missing = [k for k in required if k not in features or features.get(k) in (None, "")]
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required fields: {', '.join(missing)}")

    # Bind & type
    try:
        player_id: int = int(features["player_id"])
        team_id: int = int(features["team_id"])
        game_id: int = int(features["game_id"])   # MUST exist
        game_date: str = str(features["game_date"])
        prop_type: str = str(features["prop_type"])
        prop_value_num: float = float(features["prop_value"])
        over_under: str = str(features.get("over_under") or "over")
    except (KeyError, ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Bad or missing field types in required fields")

    # Optional: probability carried in token or features
    prob = data.get("prob") or features.get("probability")

    # Source scope (defaults to user_added)
    prop_source: str = (
        body.get("prop_source")
        or data.get("prop_source")
        or features.get("prop_source")
        or "user_added"
    )

    # Resolve team (abbr) if missing → prefer explicit, then by team_id, then latest by player_id
    team_abbr = None
    if isinstance(features.get("team"), str) and features["team"].strip():
        team_abbr = features["team"].strip().upper()
    if not team_abbr:
        try:
            team_abbr = get_team_abbr_from_team_id(team_id)
        except Exception:
            team_abbr = None
    if not team_abbr and player_id:
        try:
            team_abbr, _ = get_latest_team_for_player(player_id)
        except Exception:
            team_abbr = None
    if not team_abbr:
        raise HTTPException(status_code=400, detail="Could not determine team (abbr) to insert")

    # Ensure player_name (NOT NULL)
    player_name = features.get("player_name")
    if not player_name and player_id:
        player_name = _get_player_name_by_id(player_id)
    if not player_name:
        raise HTTPException(status_code=400, detail="Could not resolve player_name")

    # Optional context
    is_home = features.get("is_home")
    home_away = "home" if isinstance(is_home, (bool, int)) and bool(is_home) else ("away" if isinstance(is_home, (bool, int)) else None)

    # Duplicate check (must exactly match DB unique tuple)
    if _dup_exists(
        prop_source=prop_source,
        player_id=player_id,
        game_id=game_id,
        prop_type=prop_type,
        prop_value=prop_value_num,
    ):
        return {"saved": False, "duplicate": True}

    # Build row to match public.player_props
    row: Dict[str, Any] = {
        "game_date": game_date[:10],      # YYYY-MM-DD
        "player_name": player_name,
        "team": team_abbr,                # text abbr
        "prop_type": prop_type,
        "prop_value": float(prop_value_num),  # keep exact UI value
        "over_under": over_under,             # not part of unique tuple
        "status": "pending",
        "game_id": int(game_id),
        "player_id": int(player_id),          # BIGINT
        "team_id": int(team_id),              # BIGINT
        "prop_source": prop_source,           # uniqueness scope

        # Optional context (pass through when present)
        "confidence_score": float(prob) if prob is not None else None,
        "predicted_outcome": data.get("predicted_outcome"),
        "opponent_encoded": features.get("opponent_encoded"),
        "is_home": bool(is_home) if is_home is not None else None,
        "home_away": home_away,
        "opponent_team_id": features.get("opponent_team_id"),
        "game_day_of_week": str(features["game_day_of_week"]) if "game_day_of_week" in features and features["game_day_of_week"] is not None else None,
        "time_of_day_bucket": features.get("time_of_day_bucket"),
        "opponent": features.get("opponent"),
        "game_time": features.get("game_time"),
        "starting_pitcher_id": features.get("starting_pitcher_id"),
    }

    # Drop None values to avoid NOT NULL/column issues
    row_clean = {k: v for k, v in row.items() if v is not None}

    # Insert (upsert against the DB unique columns)
    try:
        res = (
            supabase.from_(TABLE)
            .upsert(
                row_clean,
                on_conflict="prop_source,player_id,game_id,prop_type,prop_value",
            )
            .execute()
        )
        if getattr(res, "error", None):
            raise HTTPException(status_code=500, detail=f"DB insert failed: {res.error}")
        return {"saved": True, "row": row_clean}
    except PostgrestAPIError as e:  # pragma: no cover
        text = f"{getattr(e, 'message', '')} {getattr(e, 'details', '')}"
        if "duplicate" in text.lower() or "unique" in text.lower():
            return {"saved": False, "duplicate": True}
        raise
