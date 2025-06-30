# ==========================================
# 📄 File: backend/app/routes/player_profile.py
# 📌 Purpose: FastAPI route for /player-profile/:player_id
#            Returns recent props, streaks, and stat summaries
#
# 🔁 Used by: PlayerProfileDashboard UI
# 📤 Outputs: JSON with current performance metrics across prop types
#
# 🧠 Why it uses `player_stats`:
# - Supplies season and career stat rollups using queryable numeric fields.
# - Avoids reprocessing raw boxscore JSON or training rows during request time.
# - Fallback when derived stats are incomplete or unavailable.
#
# 🔧 Notes:
# - Pulls recent props from `model_training_props`
# - Streaks from `player_streak_profiles`
# - Rollups from `player_stats`
# ==========================================


from fastapi import APIRouter, HTTPException
from datetime import datetime, timedelta, timezone
from collections import Counter
import httpx
from postgrest.exceptions import APIError
import os
import traceback

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
    print(f"🚦 Generating profile for player_id: {player_id}")

    # Player name + team
    try:
        info_resp = (
            supabase
            .from_("player_props")
            .select("player_name, team")
            .eq("player_id", player_id)
            .order("game_date", desc=True)
            .limit(1)
            .execute()
        )
        print(f"✅ player_props → name/team: {info_resp.data}")
    except Exception as e:
        print(f"❌ player_props name/team fetch failed: {e}")
        raise

    # Recent props
    try:
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
        print(f"📊 recent_props: {len(props_resp.data)} rows")
    except Exception as e:
        print(f"❌ recent_props fetch failed: {e}")
        raise

    # Streaks
    try:
        streak_resp = (
            supabase
            .from_("player_streak_profiles")
            .select("prop_type, streak_type, streak_count")
            .eq("player_id", player_id)
            .execute()
        )
        print(f"📈 streaks: {len(streak_resp.data)} rows")
    except Exception as e:
        print(f"❌ streaks fetch failed: {e}")
        raise

    # Stat-derived
    try:
        stat_derived_resp = (
            supabase
            .from_("model_training_props")
            .select("game_date, prop_type, prop_value, result, outcome")
            .eq("player_id", player_id)
            .eq("prop_source", "mlb_api")
            .in_("outcome", ["win", "loss", "push"])
            .order("game_date", desc=True)
            .limit(10)
            .execute()
        )
        print(f"📦 stat-derived: {len(stat_derived_resp.data)} rows")
    except Exception as e:
        print(f"❌ stat_derived fetch failed: {e}")
        raise

    # Training summary
    try:
        training_rows_resp = (
            supabase
            .from_("model_training_props")
            .select("prop_type")
            .eq("player_id", player_id)
            .execute()
        )
        print(f"📚 training rows: {len(training_rows_resp.data)} rows")
    except Exception as e:
        print(f"❌ training summary fetch failed: {e}")
        raise

    # MLB Stats
    try:
        stats = await fetch_player_stats(player_id)
        print(f"📊 MLB stats fetched for player {player_id}")
    except Exception as e:
        print(f"❌ MLB API fetch failed: {e}")
        raise

    ...


@router.get("/player-profile/{player_id}")
async def get_player_profile(player_id: str):
    if not player_id:
        raise HTTPException(status_code=400, detail="Player ID is required")

    # ✅ 1. Try cache lookup
    try:
        cached = (
            supabase
            .from_("player_profiles_cache")
            .select("data, updated_at")
            .eq("player_id", player_id)
            .limit(1)
            .execute()
        )

        if cached.data and isinstance(cached.data, list) and len(cached.data) > 0:
            cached_row = cached.data[0]
            updated_str = cached_row.get("updated_at")
        if updated_str:
           updated = datetime.fromisoformat(updated_str.replace("Z", "+00:00"))
        if datetime.now(timezone.utc) - updated < timedelta(minutes=CACHE_TTL_MINUTES):
            print("📦 Returning cached profile")
            return cached_row["data"]

    except Exception as e:
        print(f"⚠️ Cache fetch error for {player_id}: {e}")

    # ✅ 2. Fallback: Generate fresh profile
    try:
        profile = await generate_fresh_player_profile(player_id)
        

        # ✅ 3. Attempt to write to cache
        try:
            supabase.from_("player_profiles_cache").upsert({
                "player_id": player_id,
                "data": profile,
                "updated_at": datetime.utcnow().isoformat()
            }).execute()
        except Exception as e:
            print(f"⚠️ Failed to cache generated profile for {player_id}: {e}")

        return profile
    except Exception as e:
            print(f"🔥 Full traceback for player {player_id}:\n{traceback.format_exc()}")
    raise HTTPException(status_code=500, detail=f"Failed to generate profile for {player_id}")




