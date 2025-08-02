from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from pydantic.config import ConfigDict
from typing import Optional
from backend.scripts.shared.supabase_utils import supabase
from backend.scripts.shared.enrich_game_context import enrich_game_context
from backend.scripts.shared.upsert_player_id import upsert_player_id
import traceback

router = APIRouter()

class PreparePropInput(BaseModel):
    player_name: str = Field(alias="playerName")
    team_abbr: str = Field(alias="teamAbbr")
    prop_type: str = Field(alias="propType")
    over_under: str = Field(alias="overUnder")
    line: float
    game_id: Optional[int] = None
    game_date: Optional[str] = Field(default=None, alias="gameDate")
    is_home: Optional[bool] = Field(default=None, alias="is_home")
    opponent: Optional[str] = None
    opponent_encoded: Optional[int] = None
    game_time: Optional[str] = None
    game_day_of_week: Optional[int] = Field(default=None, alias="game_day_of_week")
    time_of_day_bucket: Optional[str] = None
    starting_pitcher_id: Optional[int] = None
    user_id: Optional[str] = None

    model_config = ConfigDict(validate_by_name=True)

@router.post("/prepareProp")
async def prepare_prop(request: Request):
    try:
        data = await request.json()
        print("📨 Raw request body:", data)
        input_data = PreparePropInput(**data)
        print("✅ Parsed PreparePropInput:", input_data)
    except Exception as e:
        print("❌ Failed to parse input:", str(e))
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=f"Invalid request: {e}")

    # 🔄 Resolve player_id
    try:
        print(f"🔍 Resolving player_id for: {input_data.player_name}, {input_data.team}")
        player_id = await upsert_player_id(input_data.player_name, input_data.team)
        print(f"✅ Resolved player_id: {player_id}")
    except Exception as e:
        print("❌ Failed during upsert_player_id:", str(e))
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to resolve player_id: {e}")

    # 🧠 Enrich game context
    try:
        print("🧠 Enriching game context...")
        enriched = await enrich_game_context({
            "player_id": player_id,
            "team": input_data.team,
            "game_id": input_data.game_id,
        })
        print("🎯 Enriched game context:", enriched)
    except Exception as e:
        print("❌ Failed during enrich_game_context:", str(e))
        traceback.print_exc()
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
