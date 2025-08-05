# File: backend/app/routes/api/predict.py

from backend.scripts.prediction.make_prediction import make_prediction
from backend.scripts.prediction.complete_feature_vector import complete_feature_vector
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
import json
import sys
import os

print("✅ predict.py is being imported")

router = APIRouter()

class FullPropFeatures(BaseModel):
    prop_type: str
    features: dict  # expects enriched fields: is_home, opponent_encoded, etc.

@router.post("/predict")
async def predict(request: Request) -> dict:
    body = await request.json()
    print(f"📩 Incoming prediction request: {body}")

    try:
        input_data = FullPropFeatures(**body)
        print(f"📥 Parsed input: {input_data.model_dump()}")
    except ValidationError as e:
        print(f"❌ Validation error: {e.errors()}")
        raise HTTPException(status_code=422, detail=e.errors())

    prop_type = input_data.prop_type

    # ✅ Fill missing fields with default values
    completed_features = complete_feature_vector(input_data.features, prop_type)

    try:
        print(f"🚀 Calling make_prediction() with {prop_type}")
        prediction_output = make_prediction({
           "prop_type": prop_type,
           "features": completed_features
        })
        print(f"🎯 Prediction result: {prediction_output}")
        return prediction_output

    except Exception as e:
        print(f"❌ Prediction error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
