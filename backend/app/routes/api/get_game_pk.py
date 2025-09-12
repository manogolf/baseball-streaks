from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Optional

# Supabase client
try:
    from backend.scripts.shared.supabase_utils import supabase
except Exception:
    try:
        from scripts.shared.supabase_utils import supabase  # fallback if PYTHONPATH differs
    except Exception:
        supabase = None

router = APIRouter()

@router.get("/getGamePk")
async def get_game_pk(player_id: int, date: str, feature_tag: str = "v1"):
    """
    Return the game_id ('gamePk') for a player on a given date by looking up
    precomputed features. This matches what /api/predict (fast path) expects.
    """
    if supabase is None:
        raise HTTPException(500, "Supabase client not available on server.")

    # Prefer newest row if multiple exist
    try:
        res = (
            supabase
            .from_("prop_features_precomputed")
            .select("game_id")
            .eq("player_id", str(player_id))
            .eq("game_date", date)
            .eq("feature_set_tag", feature_tag)
            .limit(1)
            .execute()
        )
    except Exception as e:
        raise HTTPException(500, f"Supabase error: {e}")

    rows = getattr(res, "data", None) or []
    if not rows or not rows[0].get("game_id"):
        raise HTTPException(404, f"No precomputed features for player_id={player_id} on {date} (tag={feature_tag}).")

    return {"game_id": int(rows[0]["game_id"])}
