# backend/app/routes/api/props.py

from fastapi import APIRouter, HTTPException, Request
from typing import Dict, Any, Optional

from backend.scripts.shared.supabase_utils import supabase
from backend.app.security.commit_token import verify_commit_token
from backend.app.prop_utils import get_team_abbr_from_team_id, get_latest_team_for_player

try:
    from postgrest.exceptions import APIError as PostgrestAPIError
except Exception:
    PostgrestAPIError = Exception

router = APIRouter()
TABLE = "player_props"  # user-added props table

# --- tiny helper: name by player_id from your player_ids table ---
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

def _dup_exists(*, prop_source, player_id, game_id, prop_type) -> bool:
    q = (
        supabase.from_(TABLE)
        .select("id")
        .eq("prop_source", prop_source)
        .eq("player_id", str(player_id))
        .eq("game_id", int(game_id))
        .eq("prop_type", prop_type)
        .limit(1)
    )
    res = q.execute()
    rows = getattr(res, "data", []) or []
    return bool(rows)

@router.post("/props/add")
async def add_prop(req: Request):
    body = await req.json()
    token = body.get("commit_token")
    if not token:
        raise HTTPException(status_code=400, detail="commit_token required")

    # 1) Verify token + unpack payload
    try:
        data = verify_commit_token(token)  # raises on invalid/expired
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid commit_token: {e}")

    features: Dict[str, Any] = data.get("features") or {}
    prop_type: Optional[str] = data.get("prop_type")
    prob: Optional[float] = data.get("prob")

    # Required (ID-first + prop)
    player_id  = features.get("player_id")
    team_id    = features.get("team_id")
    game_id    = features.get("game_id")
    game_date  = features.get("game_date")
    over_under = features.get("over_under")

    # strictly use prop_value (no 'line' fallback)
    prop_value_raw = features.get("prop_value")
    try:
        prop_value_num = float(prop_value_raw) if prop_value_raw is not None else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="prop_value must be numeric")

    # NEW: prop_source is the uniqueness scope (replaces user_id entirely)
    prop_source = (
        body.get("prop_source")
        or data.get("prop_source")
        or features.get("prop_source")
        or "user_added"
    )

    missing = [k for k, v in [
        ("player_id",  player_id),
        ("team_id",    team_id),
        ("game_id",    game_id),
        ("game_date",  game_date),
        ("prop_type",  prop_type),
        ("over_under", over_under),
        ("prop_value", prop_value_num),
        ("prop_source", prop_source),
    ] if v is None]
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required fields: {', '.join(missing)}")

    # 2) TEAM (abbr): prefer UI value; derive only if missing
    team_abbr = None
    if isinstance(features.get("team"), str) and features["team"].strip():
        team_abbr = features["team"].strip().upper()
    if not team_abbr and team_id is not None:
        try:
            team_abbr = get_team_abbr_from_team_id(int(team_id))
        except Exception:
            team_abbr = None
    if not team_abbr and player_id is not None:
        try:
            team_abbr, _ = get_latest_team_for_player(int(player_id))
        except Exception:
            team_abbr = None
    if not team_abbr:
        raise HTTPException(status_code=400, detail="Could not determine team (abbr) to insert")

    # 3) Ensure player_name (NOT NULL)
    player_name = features.get("player_name")
    if not player_name and player_id:
        player_name = _get_player_name_by_id(player_id)
    if not player_name:
        raise HTTPException(status_code=400, detail="Could not resolve player_name")

    # Optional context fields
    is_home = features.get("is_home")
    home_away = None
    if isinstance(is_home, (bool, int)):
        home_away = "home" if bool(is_home) else "away"

    # 4) Build row to match public.player_props
    row: Dict[str, Any] = {
        "game_date": str(game_date)[:10],      # YYYY-MM-DD
        "player_name": player_name,
        "team": team_abbr,                     # text abbr column
        "prop_type": prop_type,
        "prop_value": prop_value_num,          # normalized number
        "over_under": over_under,
        "status": "pending",                   # satisfy check constraint
        "game_id": int(game_id),
        "player_id": str(player_id),           # TEXT column in schema
        "team_id": int(team_id),

        # 🔁 Scope + context (NO user_id)
        "prop_source": prop_source,

        # Optional, if present
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

    # Drop None values to avoid NOT NULL / unknown column issues
    row_clean = {k: v for k, v in row.items() if v is not None}

    # Duplicate check: (prop_source, player_id, game_id, prop_type)
    if _dup_exists(
        prop_source=prop_source,
        player_id=player_id,
        game_id=game_id,
        prop_type=prop_type,
    ):
        return {"saved": False, "duplicate": True}

    # --- insert / upsert ---
    try:
        res = (
            supabase.from_(TABLE)
            .upsert(
                row_clean,
                on_conflict="prop_source,player_id,game_id,prop_type",
            )
            .execute()
        )

        if getattr(res, "error", None):
            raise HTTPException(status_code=500, detail=f"DB insert failed: {res.error}")

        return {"saved": True, "row": row_clean}

    except PostgrestAPIError as e:
        text = f"{getattr(e, 'message', '')} {getattr(e, 'details', '')}"
        if "duplicate" in text.lower() or "unique" in text.lower():
            return {"saved": False, "duplicate": True}
        raise
