# backend/app/routes/predict.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.score_any_prop import predict_prop
from app.supabase_client import supabase 
import os

router = APIRouter()

# ✅ Input Schema
class PropInput(BaseModel):
    prop_type: str
    prop_value: float
    rolling_result_avg_7: float
    hit_streak: int
    win_streak: int
    is_home: int
    opponent_avg_win_rate: float | None = 0
    over_under: str
    player_id: str

@router.post("/predict")
def predict(input: PropInput):
    print("📥 Normalized input:", input.model_dump())

    try:
        response = (
            supabase.table("player_streak_profiles")
            .select("streak_count, streak_type")
            .eq("player_id", input.player_id)
            .eq("prop_type", input.prop_type)
            .maybe_single()
            .execute()
        )
        streak_data = response.data or {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Supabase error: {e}")

    streak_count = streak_data.get("streak_count", 0)
    streak_type = streak_data.get("streak_type", "neutral")

    print(f"🔥 Streak: {streak_type} ({streak_count})")

    enriched_input = input.model_dump()
    enriched_input["streak_count"] = streak_count
    enriched_input["streak_type"] = streak_type

    try:
        result = predict_prop(input.prop_type, enriched_input)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Prediction error: {e}")

    print("🔮 Model response:", result)
    return result

