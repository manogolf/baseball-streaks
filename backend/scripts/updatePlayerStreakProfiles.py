import os
from datetime import datetime, timedelta
from supabase import create_client, Client
from collections import defaultdict

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def fetch_recent_resolved_props(days=30):
    today = datetime.utcnow().date()
    since = today - timedelta(days=days)

    response = supabase.table("player_props") \
        .select("*") \
        .gte("game_date", since.isoformat()) \
        .neq("outcome", None) \
        .eq("status", "resolved") \
        .order("game_date", desc=True) \
        .execute()

    return response.data or []

def compute_streaks_and_avg(props):
    streak_profiles = {}

    grouped = defaultdict(list)
    for prop in props:
        key = (prop["player_id"], prop["prop_type"])
        grouped[key].append(prop)

    for (player_id, prop_type), entries in grouped.items():
        sorted_entries = sorted(entries, key=lambda p: p["game_date"], reverse=True)
        outcomes = [p["outcome"] for p in sorted_entries[:7]]
        wins = sum(1 for o in outcomes if o == "win")
        rolling_avg = round(wins / len(outcomes), 3) if outcomes else 0

        hit_streak = 0
        win_streak = 0
        for o in outcomes:
            if o == "win":
                hit_streak += 1
                win_streak += 1
            else:
                break

        streak_profiles[(player_id, prop_type)] = {
            "player_id": player_id,
            "prop_type": prop_type,
            "hit_streak": hit_streak,
            "win_streak": win_streak,
            "rolling_result_avg_7": rolling_avg,
            "streak_type": "neutral",
        }

    return list(streak_profiles.values())

def upsert_streak_profiles(profiles):
    if not profiles:
        print("⚠️ No streak data to upsert.")
        return

    response = (
        supabase.table("player_streak_profiles")
        .upsert(profiles, on_conflict=["player_id", "prop_type"])  # ✅ Conflict handling
        .execute()
    )
    print(f"✅ Upserted {len(profiles)} streak profiles")


def main():
    print("📦 Fetching recent resolved props...")
    props = fetch_recent_resolved_props()

    if not props:
        print("⚠️ No resolved props found — skipping.")
        return

    print(f"🧠 Processing {len(props)} props...")
    profiles = compute_streaks_and_avg(props)
    upsert_streak_profiles(profiles)

if __name__ == "__main__":
    main()
