from fastapi import APIRouter, HTTPException, Query
from app.services.supabase_queries import (
    players_all, player_lookup, players_search, players_by_team
)

router = APIRouter()

# ✅ Compat for existing frontend component (no /api prefix)
@router.get("/players")
def players_list_all():
    return players_all()

# ✅ Lookup by id (preferred) or name (fallback)
@router.get("/players/lookup")
def players_lookup_route(
    player_id: str | None = Query(None),
    player_name: str | None = Query(None)
):
    if not player_id and not player_name:
        raise HTTPException(status_code=400, detail="Provide player_id or player_name")
    row = player_lookup(player_id=player_id, player_name=player_name)
    if not row:
        raise HTTPException(status_code=404, detail="player not found")
    return {"ok": True, "data": row}

# ✅ Search by name OR id (substring)
@router.get("/players/search")
def players_search_route(
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(10, ge=1, le=50)
):
    return {"ok": True, "data": players_search(q, limit)}

# ✅ By team: prefer team_id, fallback to team text
@router.get("/players/by_team")
def players_by_team_route(
    team_id: int | None = Query(None, ge=1),
    team: str | None = Query(None)
):
    data = players_by_team(team_id=team_id, team=team)
    return {"ok": True, "data": data}
