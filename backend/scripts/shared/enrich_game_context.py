# File: backend/scripts/shared/enrich_game_context.py

import requests
from datetime import datetime
from backend.scripts.shared.team_name_map import normalize_team_abbreviation, team_id_map
from backend.scripts.shared.time_utils_backend import get_time_of_day_bucket_et

MLB_API_SCHEDULE = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date="
MLB_API_FEED = "https://statsapi.mlb.com/api/v1.1/game/{game_id}/feed/live"

def get_schedule(date):
    url = f"{MLB_API_SCHEDULE}{date}"
    res = requests.get(url)
    res.raise_for_status()
    return res.json()

def get_feed_live(game_id):
    url = MLB_API_FEED.format(game_id=game_id)
    res = requests.get(url)
    res.raise_for_status()
    return res.json()

def encode_team(team_abbr):
    teams = list(team_id_map.keys())
    return teams.index(team_abbr) if team_abbr in teams else -1

def enrich_game_context(input):
    player_id = input.get("player_id")
    team_abbr = normalize_team_abbreviation(input.get("team"))
    game_id = input.get("game_id")

    if not game_id:
        raise ValueError("Missing game_id in input")

    feed = get_feed_live(game_id)
    game_data = feed.get("gameData", {})
    datetime_str = game_data.get("datetime", {}).get("dateTime")

    if not datetime_str:
        raise ValueError("Missing game datetime from feed")

    game_time = datetime.fromisoformat(datetime_str.replace("Z", "+00:00"))
    time_of_day_bucket = get_time_of_day_bucket_et(game_time)

    home_team = game_data.get("teams", {}).get("home", {}).get("abbreviation")
    away_team = game_data.get("teams", {}).get("away", {}).get("abbreviation")

    is_home = int(home_team == team_abbr)
    opponent = away_team if is_home else home_team
    opponent_encoded = encode_team(opponent)

    # 🔍 Probable Pitcher
    probable_pitcher_id = None
    try:
        probable = game_data.get("probablePitchers", {})
        pitcher = probable.get("away") if is_home else probable.get("home")
        probable_pitcher_id = pitcher.get("id") if pitcher else None
    except Exception:
        probable_pitcher_id = None

    return {
        "game_id": game_id,
        "game_time": game_time.isoformat(),
        "game_day_of_week": game_time.weekday(),
        "time_of_day_bucket": time_of_day_bucket,
        "is_home": is_home,
        "opponent": opponent,
        "opponent_encoded": opponent_encoded,
        "starting_pitcher_id": probable_pitcher_id,
    }
