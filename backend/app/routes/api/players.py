# backend/app/routes/api/players.py
from fastapi import APIRouter, HTTPException, Query
from typing import Optional

from app.services.supabase_queries import (
    players_all,
    player_lookup,
    players_search,
    players_by_team,
)
from app.prop_utils import get_player_id_by_name, get_latest_team_for_player

router = APIRouter()

# List all players (compat)
@router.get("/players")
def players_list_all():
    return players_all()

# Lookup by id (preferred) or name (fallback)
@router.get("/players/lookup")
def players_lookup_route(
    player_id: str | None = Query(None),
    player_name: str | None = Query(None),
):
    if not player_id and not player_name:
        raise HTTPException(status_code=400, detail="Provide player_id or player_name")
    row = player_lookup(player_id=player_id, player_name=player_name)
    if not row:
        raise HTTPException(status_code=404, detail="player not found")
    return {"ok": True, "data": row}

# Search by name OR id (substring)
@router.get("/players/search")
def players_search_route(
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(10, ge=1, le=50),
):
    return {"ok": True, "data": players_search(q, limit)}

# By team: prefer team_id, fallback to team text
@router.get("/players/by_team")
def players_by_team_route(
    team_id: int | None = Query(None, ge=1),
    team: str | None = Query(None),
):
    data = players_by_team(team_id=team_id, team=team)
    return {"ok": True, "data": data}

# New: resolve by NAME → {player_id, team_abbr}
@router.get("/players/resolve")
def resolve_player(name: str = Query(..., min_length=2), date: Optional[str] = None):
    """
    Resolve by NAME ONLY.
    Reads from public.player_ids and returns the most recent team (by updated_at).
    """
    pid = get_player_id_by_name(name)
    if not pid:
        raise HTTPException(status_code=404, detail="Player not found")

    team_abbr, _team_id = get_latest_team_for_player(int(pid))
    if not team_abbr:
        raise HTTPException(status_code=404, detail="Team not found for player")

    return {"player_id": int(pid), "name": name, "team_abbr": team_abbr}
