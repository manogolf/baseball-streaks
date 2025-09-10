#  backend/app/routes/api/predict.py

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Any, Dict, Optional
from pathlib import Path
import os, json
import joblib
from scripts.modeling.build_feature_vector import FEATURE_NAMES, META_PATH
from scripts.modeling.build_feature_vector import build_feature_vector
from app.security.commit_token import mint_commit_token
from app.config import COMMIT_TOKEN_SECRET, COMMIT_TOKEN_TTL


router = APIRouter()

# Resolve /backend/models from this file
MODELS_DIR = Path(__file__).resolve().parents[3] / "models"

class PredictInput(BaseModel):
    prop_type: str
    features: Dict[str, Any]
    # Optional legacy fields tolerated but unused here
    player_id: Optional[int] = None
    team_id: Optional[int] = None
    game_id: Optional[int] = None

def _pick_model_path(prop_type: str) -> Optional[Path]:
    import os
    override = os.getenv(f"MODEL_FILE_{prop_type}") or os.getenv("MODEL_FILE")
    if not override:
        return None
    p = Path(override)
    return p if p.exists() else None

@router.post("/predict")
async def predict(req: Request) -> Dict[str, Any]:
    payload = await req.json()
    inp = PredictInput(**payload)
    orig = dict(inp.features or {})                 # what client sent
    base = {name: 0 for name in FEATURE_NAMES}      # defaults
    base.update(orig)                               # client values override defaults

    missing_features = [n for n in FEATURE_NAMES if n not in base]  # will be []
    
    model_path = _pick_model_path(inp.prop_type)
    if not model_path:
        raise HTTPException(404, f"Model file not found for prop_type '{inp.prop_type}'")

    # Build the ordered vector (missing values → 0.0)
    X = [build_feature_vector(base)]

    # Load model
    try:
        model = joblib.load(str(model_path))
    except Exception as e:
        raise HTTPException(500, f"Failed to load model: {e}")

    # Predict
    try:
        if hasattr(model, "predict_proba"):
            proba = float(model.predict_proba(X)[0][1])
        elif hasattr(model, "predict"):
            y = model.predict(X)
            proba = float(y[0]) if isinstance(y, (list, tuple)) else float(y)
        else:
            raise AttributeError("Model lacks predict_proba/predict")
    except Exception as e:
        raise HTTPException(500, f"Inference failed: {e}")

    # inside predict(), right before the return
    token_data = {
        "prop_type": inp.prop_type,
        "features": base,          # the prefilled dict you built
        "probability": proba,
    }
    # base is the dict of features you’re actually sending to the model
    commit_token = mint_commit_token(        
        prob=float(proba),
        prop_type=inp.prop_type,
        features=base,
        ttl_seconds=COMMIT_TOKEN_TTL,
        secret=COMMIT_TOKEN_SECRET,
    )

    return {
        "prop_type": inp.prop_type,
        "model": model_path.name,
        "probability": proba,
        "features_used": len(X[0]),
        "missing_features": missing_features,
        "missing_count": len(missing_features),
        "commit_token": commit_token,
    }

@router.get("/featureMeta/{prop_type}")
async def feature_meta(prop_type: str):
    # For now we expose whatever FEATURE_META_PATH points to (you set it per prop).
    return {
        "prop_type": prop_type,
        "meta_path": str(META_PATH),
        "feature_names": FEATURE_NAMES,
        "count": len(FEATURE_NAMES),
    }
