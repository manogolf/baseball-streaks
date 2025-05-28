from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from app.score_any_prop import predict_prop
from archive.supabase_client import supabase
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
    player_id: str  # Confirmed as string type

@router.post("/predict")
async def predict(request: Request):
    body = await request.json()
    print(f"📩 Raw Incoming Payload: {body}")
    print(f"🔎 Raw player_id type: {type(body.get('player_id'))}")

    try:
        input_data = PropInput(**body)
        print(f"📥 Normalized input after validation: {input_data.model_dump()}")
    except ValidationError as e:
        print(f"❌ Validation Error Details: {e.errors()}")
        raise HTTPException(status_code=422, detail=e.errors())

    print("✅ Validation passed, proceeding to Supabase call and prediction...")
    print("📡 [Temporarily Disabled] Supabase streak profile fetch...")

    # === Original Supabase streak logic (commented for restoration) ===
    # try:
    #     response = (
    #         supabase.table("player_streak_profiles")
    #         .select("streak_count, streak_type")
    #         .eq("player_id", input_data.player_id)
    #         .eq("prop_type", input_data.prop_type)
    #         .maybe_single()
    #         .execute()
    #     )
    #     streak_data = response.data or {}
    # except Exception as e:
    #     raise HTTPException(status_code=500, detail=f"Supabase error: {e}")

    # streak_count = streak_data.get("streak_count", 0)
    # streak_type = streak_data.get("streak_type", "neutral")

    # 🚫 Using Defaults Instead of Supabase
    streak_count = 0
    streak_type = "neutral"
    print("📉 Bypassing streak profile. Defaults applied: streak_count=0, streak_type='neutral'")

    enriched_input = input_data.model_dump()
    enriched_input["streak_count"] = streak_count
    enriched_input["streak_type"] = streak_type

    print(f"📦 Enriched Input Before Prediction: {enriched_input}")
    print(f"🔤 Final player_id type before prediction: {type(enriched_input.get('player_id'))}")

    try:
        print(f"🔮 Calling predict_prop with prop_type={input_data.prop_type} and enriched_input={enriched_input}")
        result = predict_prop(input_data.prop_type, enriched_input)
    except Exception as e:
        print(f"❌ Prediction function error: {e}")
        raise HTTPException(status_code=500, detail=f"Prediction error: {e}")

    print(f"🎯 Model Prediction Response: {result}")
    return result
