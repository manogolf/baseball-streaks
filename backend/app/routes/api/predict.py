# File: backend/app/routes/api/predict.py

import os
import joblib
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from backend.scripts.prediction.complete_feature_vector import complete_feature_vector
from backend.scripts.prediction.make_prediction import make_prediction
from backend.scripts.prediction.make_prediction import load_model_from_supabase

router = APIRouter()
print("✅ predict.py is being imported")

# ✅ Global cache
model_cache = {}


def load_model_cached(prop_type: str, model_kind: str):
    key = f"{prop_type}_{model_kind}"
    if key in model_cache:
        return model_cache[key]

    model_path = f"{prop_type}/{prop_type}_{model_kind}_compressed.pkl"
    model = load_model_from_supabase("models", model_path)
    model_cache[key] = model
    print(f"📦 Loaded and cached model from Supabase: {model_path}")
    return model

class FullPropFeatures(BaseModel):
    prop_type: str
    features: dict


@router.post("/predict")
async def predict(request: Request) -> dict:
    body = await request.json()
    print(f"📩 Incoming prediction request: {body}")

    try:
        input_data = FullPropFeatures(**body)
    except ValidationError as e:
        print(f"❌ Validation error: {e.errors()}")
        raise HTTPException(status_code=422, detail=e.errors())

    prop_type = input_data.prop_type
    completed_features = complete_feature_vector(input_data.features, prop_type)

    try:
        print(f"🚀 Calling make_prediction() for {prop_type}")
        prediction_output = make_prediction({
        "prop_type": prop_type,
        "features": completed_features,
    })
        print(f"🎯 Prediction result: {prediction_output}")
        return prediction_output

    except Exception as e:
        print(f"❌ Prediction error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
