# backend/app/routes/predict.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.score_any_prop import predict_prop
from supabase import create_client, Client
import os

router = APIRouter()

# ✅ Supabase Client Setup
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

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

    # 🔄 Fetch streak info
    try:
        streak_resp = (
            supabase.table("player_streak_profiles")
            .select("streak_count, streak_type")
            .eq("player_id", input.player_id)
            .eq("prop_type", input.prop_type)
            .maybe_single()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Supabase error: {e}")

    if not streak_resp:
        streak_count, streak_type = 0, "neutral"
    else:
        streak_count = streak_resp.get("streak_count", 0)
        streak_type = streak_resp.get("streak_type", "neutral")

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
