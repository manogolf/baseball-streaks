# File: backend/app/routes/api/predict.py

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
import subprocess
import json
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../..")))

router = APIRouter()

class FullPropFeatures(BaseModel):
    prop_type: str
    features: dict  # expects enriched fields: is_home, opponent_encoded, etc.

@router.post("/predict")
async def predict(request: Request):
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

    script_path = os.path.abspath("backend/scripts/prediction/makePrediction.mjs")
    model_dir = f"backend/models/{prop_type}"
    rf_path = os.path.join(model_dir, f"{prop_type}_random_forest.pkl")
    lr_path = os.path.join(model_dir, f"{prop_type}_logistic_regression.pkl")

    try:
        print(f"🚀 Calling makePrediction.mjs with {prop_type}")
        result = subprocess.run(
            ["node", script_path, features_json, rf_path, lr_path],
            check=True,
            capture_output=True,
            text=True
        )
        prediction_output = json.loads(result.stdout)
        print(f"🎯 Prediction result: {prediction_output}")
        return prediction_output
    except subprocess.CalledProcessError as e:
        print(f"❌ Subprocess error:\n{e.stderr}")
        raise HTTPException(status_code=500, detail="Prediction script failed.")
    except Exception as e:
        print(f"❌ Unexpected error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
