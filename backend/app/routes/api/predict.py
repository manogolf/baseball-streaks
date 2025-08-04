# File: backend/app/routes/api/predict.py

from backend.scripts.prediction.make_prediction import make_prediction
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
import json
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../..")))

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
    features_json = json.dumps(input_data.features)

    model_dir = f"backend/models/{prop_type}"
    rf_path = os.path.join(model_dir, f"{prop_type}_random_forest.pkl")
    lr_path = os.path.join(model_dir, f"{prop_type}_logistic_regression.pkl")

    try:
        print(f"🚀 Calling make_prediction() with {prop_type}")
        prediction_output = make_prediction(
            input_data.features,  # ✅ positional args
            rf_path,
            lr_path,
        )
        print(f"🎯 Prediction result: {prediction_output}")
        return prediction_output

    except Exception as e:
        print(f"❌ Prediction error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
