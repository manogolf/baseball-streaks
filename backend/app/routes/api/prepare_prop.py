from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, AliasChoices
from typing import Optional, Dict, Any

from backend.scripts.shared.enrich_game_context import enrich_game_context
from backend.app.prop_utils import (
    get_player_id_by_name,
    get_latest_team_for_player,
    get_team_abbr_from_team_id,           # ✅ add
    find_game_id_by_team_id_and_date,     # ✅ add (ID-first)
)
router = APIRouter()

# at top of file
from pydantic import BaseModel, Field, AliasChoices
from pydantic.config import ConfigDict
from typing import Optional

class PreparePropInput(BaseModel):
    # Accept both snake_case and camelCase (and a couple legacy names)
    player_id: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices("player_id", "playerId"),
    )
    player_name: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("player_name", "playerName"),
    )
    team_abbr: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("team", "team_abbr", "teamAbbr"),
    )
    team_id: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices("team_id", "teamId"),
    )
    prop_type: str = Field(
        validation_alias=AliasChoices("prop_type", "propType"),
    )
    over_under: str = Field(
        validation_alias=AliasChoices("over_under", "overUnder"),
    )
    # allow either prop_value or legacy "line"
    prop_value: float = Field(
        validation_alias=AliasChoices("prop_value", "line"),
    )
    game_date: str = Field(
        validation_alias=AliasChoices("game_date", "gameDate"),
    )
    game_id: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices("game_id", "gameId"),
    )

    # be lenient with extra keys from the UI
    model_config = ConfigDict(extra="ignore")

@router.post("/prepareProp")
async def prepare_prop(req: Request) -> Dict[str, Any]:
    payload = await req.json()
    inp = PreparePropInput(**payload)

    # 1) player_id
    pid = inp.player_id or (get_player_id_by_name(inp.player_name) if inp.player_name else None)
    if not pid:
        raise HTTPException(400, "Provide playerId or playerName.")

    # 2) team_id
    tid = inp.team_id
    if not tid:
        _abbr, tid = get_latest_team_for_player(pid)
        if not tid:
            raise HTTPException(404, "Could not determine teamId for player")

    # 3) game_id
    gid = inp.game_id
    if not gid:
        if not inp.game_date:
            raise HTTPException(400, "Provide gameId or gameDate.")
        gid = find_game_id_by_team_id_and_date(team_id=tid, game_date=inp.game_date)
        if not gid:
            raise HTTPException(404, f"No game found for teamId={tid} on {inp.game_date}")
    # 4) enrichment (derive abbr ONLY for the helper if it needs it)
    team_abbr = get_team_abbr_from_team_id(tid)  # display-only / enrichment-only
    ctx = enrich_game_context({
        "player_id": pid,
        "team_id": tid,
        "team": team_abbr,        # safe to send if your enrich expects abbr
        "game_id": gid,
        "game_date": inp.game_date,
    })

    features = {
        "player_id": pid,
        "team_id": tid,
        "game_id": gid,
        "game_date": inp.game_date,
        "prop_type": inp.prop_type,
        "over_under": inp.over_under,
        "prop_value": float(inp.prop_value),
        "team": team_abbr,
        **(ctx or {}),
    }
    return {"features": features}