from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from pydantic.config import ConfigDict  
from backend.scripts.shared.supabase_utils import supabase
from backend.scripts.shared.enrich_game_context import enrich_game_context
from backend.scripts.shared.upsert_player_id import upsert_player_id
import traceback



router = APIRouter()

class PreparePropInput(BaseModel):
    player_name: str = Field(alias="playerName")
    team: str = Field(alias="teamAbbr")
    prop_type: str = Field(alias="propType")
    over_under: str = Field(alias="overUnder")
    line: float
    game_id: int | None = None

    model_config = ConfigDict(validate_by_name=True)

@router.post("/prepareProp")
async def prepare_prop(request: Request):
    try:
        data = await request.json()
        print("📨 Raw request body:", data)
        input_data = PreparePropInput(**data)

        player_id = await upsert_player_id(input_data.player_name, input_data.team)

        enriched = await enrich_game_context({
            "player_id": player_id,
            "team": input_data.team,
            "game_id": input_data.game_id,
        })

        enriched.update({
            "player_id": player_id,
            "player_name": input_data.player_name,
            "team": input_data.team,
            "prop_type": input_data.prop_type,
            "line": input_data.line,
            "over_under": input_data.over_under,
        })

        return enriched

    except Exception as e:
        print("❌ Exception in prepare_prop:", str(e))
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Internal server error: {e}")
