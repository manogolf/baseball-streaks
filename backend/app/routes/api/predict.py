from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from app.services.model_registry import canonicalize_prop_type
from backend.scripts.prediction.make_prediction import make_prediction
from typing import Any, Dict
from app.security.commit_token import make_commit_token

class FullPropFeatures(BaseModel):
    prop_type: str
    features: dict

router = APIRouter()

@router.post("/predict")
async def predict(req: Request):
    p: Dict[str, Any] = await req.json()  # expects { prop_type, features }
    # TODO: call your real model here
    prob = 0.5

    commit_payload = {
        "prop_type": p.get("prop_type"),
        "features": p.get("features"),
        "prob": prob,
    }
    token = make_commit_token(commit_payload)
    return {"prob": prob, "commit_token": token, "meta": {"stub": True}}