# backend/app/routes/player_profile.py

from fastapi import APIRouter, Path, HTTPException
from supabase import create_client, Client
import os
import httpx

router = APIRouter()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

@router.get("/player-profile/{player_id}")
async def get_player_profile(player_id: str = Path(..., description="MLB player ID")):
    try:
        props_resp = (
            supabase.table("player_props")
            .select("*")
            .eq("player_id", player_id)
            .neq("outcome", None)
            .order("game_date", desc=True)
            .limit(10)
            .execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Supabase error: {e}")

    props = props_resp.data or []
    recent_outcomes = [p["outcome"] for p in props]
    wins = sum(1 for o in recent_outcomes if o == "win")
    rolling_avg = wins / len(recent_outcomes) if recent_outcomes else 0

    hit_streak = 0
    for o in recent_outcomes:
        if o == "win":
            hit_streak += 1
        else:
            break

    mlb_url = f"https://statsapi.mlb.com/api/v1/people/{player_id}?hydrate=stats(group=[hitting,pitching],type=[career,season])"
    try:
        async with httpx.AsyncClient() as client:
            mlb_resp = await client.get(mlb_url)
        mlb_data = mlb_resp.json()
        stats = mlb_data.get("people", [{}])[0].get("stats", [])

        career_stats = next((s["splits"][0]["stat"] for s in stats if s["type"]["displayName"] == "career"), {})
        season_stats = next((s["splits"][0]["stat"] for s in stats if s["type"]["displayName"] == "season"), {})

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MLB API error: {e}")

    return {
        "player_id": player_id,
        "recent_props": props,
        "rolling_result_avg_7": round(rolling_avg, 3),
        "hit_streak": hit_streak,
        "career_stats": career_stats,
        "season_stats": season_stats,
    }
