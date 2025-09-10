# backend/app/services/game_info.py

from __future__ import annotations
from typing import Optional, Dict, Any
from scripts.shared.supabase_utils import supabase
from scripts.shared.team_name_map import get_team_id_from_abbr
from scripts.shared.mlb_api_v2 import GameLite, get_game_time_et

def get_game_info(game_id: int) -> Optional[Dict[str, Any]]:
    res = supabase.from_("game_info").select("*").eq("game_id", game_id).limit(1).execute()
    rows = getattr(res, "data", []) or []
    return rows[0] if rows else None

def ensure_game_info(game: GameLite) -> None:
    """
    
    Idempotent: if the row exists, we’re done. Otherwise insert minimal context
    required by your FK.
    """
    if get_game_info(game.game_id):
        return

    game_time = game.game_time or get_game_time_et(game.game_id)
    row = {
        "game_id": int(game.game_id),
        "game_date": str(game.game_date),
        "home_team_id": int(game.home_team_id),
        "away_team_id": int(game.away_team_id),
        "game_time": game_time,                       # timestamptz (can be None)
        "starting_pitcher_id_home": game.sp_home_id,  # nullable
        "starting_pitcher_id_away": game.sp_away_id,  # nullable
        # add more columns if your schema has them; None fields will be dropped by upsert below if needed
    }
    # drop Nones if your table has NOT NULLs beyond those above
    row = {k: v for k, v in row.items() if v is not None}

    supabase.from_("game_info").upsert(row, on_conflict="game_id").execute()
