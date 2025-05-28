from fastapi import APIRouter, HTTPException
from datetime import datetime, timedelta, timezone
from collections import Counter
import httpx

from scripts.shared.supabase_utils import supabase

router = APIRouter()
CACHE_TTL_MINUTES = 60  # Cache freshness threshold


def get_current_season():
    return datetime.utcnow().year


async def fetch_player_stats(player_id):
    year = get_current_season()
    base_url = "https://statsapi.mlb.com/api/v1/people"

    urls = {
        "hitting_season": f"{base_url}/{player_id}/stats?stats=season&season={year}&group=hitting",
        "hitting_career": f"{base_url}/{player_id}/stats?stats=career&group=hitting",
        "pitching_season": f"{base_url}/{player_id}/stats?stats=season&season={year}&group=pitching",
        "pitching_career": f"{base_url}/{player_id}/stats?stats=career&group=pitching",
    }

    stats = {}
    async with httpx.AsyncClient() as client:
        for label, url in urls.items():
            try:
                res = await client.get(url)
                json = res.json()
                stat = json["stats"][0]["splits"][0]["stat"] if json["stats"] and json["stats"][0]["splits"] else None
                stats[label] = stat
            except Exception as e:
                print(f"⚠️ Failed to fetch {label} for {player_id}: {e}")
                stats[label] = None

    return stats


async def generate_fresh_player_profile(player_id: str):
    # Fetch player name and team
    info_resp = (
        supabase
        .from_("player_props")
        .select("player_name, team")
        .eq("player_id", player_id)
        .order("game_date", desc=True)
        .limit(1)
        .execute()
    )
    if not info_resp.data or len(info_resp.data) == 0:
        raise HTTPException(status_code=404, detail="Player not found")

    player_name = info_resp.data[0].get("player_name", "")
    team = info_resp.data[0].get("team", "")

    # Resolved Props
    props_resp = (
        supabase
        .from_("player_props")
        .select("*")
        .eq("player_id", player_id)
        .neq("outcome", None)
        .order("game_date", desc=True)
        .limit(10)
        .execute()
    )
    if props_resp.data is None:
        raise HTTPException(status_code=500, detail="Failed to fetch recent props")

    # Streaks
    streak_resp = (
        supabase
        .from_("player_streak_profiles")
        .select("prop_type, streak_type, streak_count")
        .eq("player_id", player_id)
        .execute()
    )
    if streak_resp.data is None:
        raise HTTPException(status_code=500, detail="Failed to fetch streaks")

    # Stat-Derived Props
    stat_derived_resp = (
        supabase
        .from_("model_training_props")
        .select("game_date, prop_type, prop_value, result, outcome")
        .eq("player_id", player_id)
        .eq("source", "stat_derived")
        .in_("outcome", ["win", "loss", "push"])
        .order("game_date", desc=True)
        .limit(10)
        .execute()
    )
    if stat_derived_resp.data is None:
        raise HTTPException(status_code=500, detail="Failed to fetch stat-derived props")

    # Training Summary
    training_rows_resp = (
        supabase
        .from_("model_training_props")
        .select("prop_type")
        .eq("player_id", player_id)
        .execute()
    )
    if training_rows_resp.data is None:
        raise HTTPException(status_code=500, detail="Failed to fetch training data")

    training_counts = Counter(row.get("prop_type") for row in training_rows_resp.data if row.get("prop_type"))
    training_summary = [{"prop_type": k, "count": v} for k, v in training_counts.items()]

    # MLB Stats
    stats = await fetch_player_stats(player_id)

    return {
        "player_id": player_id,
        "player_name": player_name,
        "team": team,
        "recent_props": props_resp.data,
        "streaks": streak_resp.data,
        "stat_derived_props": stat_derived_resp.data,
        "training_summary": training_summary,
        "season_stats": {
            "hitting": stats["hitting_season"],
            "pitching": stats["pitching_season"]
        },
        "career_stats": {
            "hitting": stats["hitting_career"],
            "pitching": stats["pitching_career"]
        },
    }


@router.get("/player-profile/{player_id}")
async def get_player_profile(player_id: str):
    if not player_id:
        raise HTTPException(status_code=400, detail="Player ID is required")

    # 1. Try cache
    cached = (
        supabase
        .table("player_profiles_cache")
        .select("*")
        .eq("player_id", player_id)
        .maybe_single()
        .execute()
    )
    if cached and cached.data and "updated_at" in cached.data:
       try:
           updated = datetime.fromisoformat(cached.data["updated_at"])
           if datetime.now(timezone.utc) - updated < timedelta(minutes=CACHE_TTL_MINUTES):
            print("📦 Returning cached profile")
            return cached.data["cached_json"]
       except Exception as e:
        print(f"⚠️ Failed to parse cached timestamp: {e}")




    # 2. Recompute
    profile = await generate_fresh_player_profile(player_id)

    # 3. Save to cache
    (
        supabase
        .table("player_profiles_cache")
        .upsert({
            "player_id": player_id,
            "cached_json": profile,
            "updated_at": datetime.utcnow().isoformat()
        })
        .execute()
    )

    return profile

