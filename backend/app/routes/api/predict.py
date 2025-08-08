from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from app.services.model_registry import canonicalize_prop_type
from backend.scripts.prediction.make_prediction import make_prediction

class FullPropFeatures(BaseModel):
    prop_type: str
    features: dict

router = APIRouter()

@router.post("/predict")
async def predict(request: Request) -> dict:
    body = await request.json()
    try:
        data = FullPropFeatures(**body)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=e.errors())

    try:
        _ = canonicalize_prop_type(data.prop_type)  # raises if unknown
        return make_prediction({"prop_type": data.prop_type, "features": data.features})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
