from fastapi import APIRouter, HTTPException
from supabase import create_client
import os
from datetime import datetime, timedelta

router = APIRouter()

# Supabase Client Setup
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

@router.get("/player-profile/{player_id}")
async def get_player_profile(player_id: str):
    if not player_id:
        raise HTTPException(status_code=400, detail="Player ID is required")

    # Step 1: Fetch recent resolved props (last 7 games)
    today = datetime.utcnow().date()
    seven_days_ago = today - timedelta(days=7)

    props_resp = (
        supabase
        .from_("player_props")
        .select("*")
        .eq("player_id", player_id)
        .eq("status", "win")
        .gte("game_date", seven_days_ago.isoformat())
        .order("game_date", desc=True)
        .limit(10)
        .execute()
    )

    if props_resp.error:
        raise HTTPException(status_code=500, detail="Failed to fetch props")

    recent_props = props_resp.data

    # Step 2: Add streak logic
    current_streak = 0
    streak_type = None

    for prop in recent_props:
        if prop["outcome"] == "win":
            if streak_type in [None, "win"]:
                streak_type = "win"
                current_streak += 1
            else:
                break
        elif prop["outcome"] == "loss":
            if streak_type in [None, "loss"]:
                streak_type = "loss"
                current_streak += 1
            else:
                break

    return {
        "player_id": player_id,
        "recent_props": recent_props,
        "streak": {
            "count": current_streak,
            "type": streak_type or "neutral"
        }
    }
