from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from backend.scripts.shared.supabase_utils import supabase
from backend.scripts.shared.enrich_game_context import enrich_game_context
from backend.scripts.shared.player_utils_backend import upsert_player_id

router = APIRouter()

class PreparePropInput(BaseModel):
    player_name: str
    team: str
    prop_type: str
    over_under: str
    line: float
    game_id: int | None = None

@router.post("/prepareProp")
async def prepare_prop(request: Request):
    try:
        data = await request.json()
        input_data = PreparePropInput(**data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {e}")

    # 🔄 Resolve player_id
    try:
        player_id = await upsert_player_id(input_data.player_name, input_data.team)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to resolve player_id: {e}")

    # 🧠 Enrich game context
    try:
        enriched = await enrich_game_context({
            "player_id": player_id,
            "team": input_data.team,
            "game_id": input_data.game_id,
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Game context enrichment failed: {e}")

    enriched.update({
        "player_id": player_id,
        "player_name": input_data.player_name,
        "team": input_data.team,
        "prop_type": input_data.prop_type,
        "line": input_data.line,
        "over_under": input_data.over_under,
    })

    return enriched
