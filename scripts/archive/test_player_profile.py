# scripts/test_player_profile.py
import requests
import time

# 🔁 Replace with actual recent MLB player IDs
TEST_PLAYER_IDS = [
    "665019",  # Julio Rodriguez
    "592450",  # Mookie Betts
    "605141",  # Juan Soto
    "682998",  # Bobby Witt Jr.
    "668939",  # Adley Rutschman
]

API_BASE = "https://baseball-streaks-sq44.onrender.com"

def test_profile(player_id):
    url = f"{API_BASE}/player-profile/{player_id}"
    try:
        res = requests.get(url, timeout=10)
        if res.status_code != 200:
            print(f"❌ [{player_id}] Error {res.status_code}: {res.text}")
            return False

        data = res.json()
        missing = []
        if not data.get("recent_props"): missing.append("recent_props")
        if not data.get("career_stats"): missing.append("career_stats")
        if not data.get("season_stats"): missing.append("season_stats")

        if missing:
            print(f"⚠️  [{player_id}] Missing fields: {', '.join(missing)}")
            return False

        print(f"✅ [{player_id}] Profile OK")
        return True

    except Exception as e:
        print(f"❌ [{player_id}] Exception: {e}")
        return False

def main():
    print("\n🧪 Testing player profile route...\n")
    success = 0
    for pid in TEST_PLAYER_IDS:
        if test_profile(pid):
            success += 1
        time.sleep(1)  # throttle just slightly

    print(f"\n✅ Completed: {success}/{len(TEST_PLAYER_IDS)} profiles OK\n")

if __name__ == "__main__":
    main()
