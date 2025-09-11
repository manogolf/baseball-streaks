#  backend/app/routes/api/predict.py
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from pathlib import Path
import os, json, joblib

from app.security.commit_token import mint_commit_token
from app.config import COMMIT_TOKEN_SECRET, COMMIT_TOKEN_TTL

router = APIRouter()

# -----------------------------
# Models/Features discovery
# -----------------------------
def _models_root() -> Path:
    """
    Single source of truth for model + feature discovery.
    Priority:
      1) MODELS_ROOT
      2) MODELS_DIR or MODEL_DIR
      3) repo default: <repo>/ml/models
    """
    env = os.getenv("MODELS_ROOT") or os.getenv("MODELS_DIR") or os.getenv("MODEL_DIR")
    if env:
        return Path(env).resolve()
    # backend/app/routes/api/predict.py -> parents[4] is repo root
    return Path(__file__).resolve().parents[4] / "ml" / "models"

def _prop_folders(prop: str) -> List[Path]:
    """
    Candidate folders that may contain models/features for a prop.
    """
    root = _models_root()
    return [
        root / "batter" / prop,
        root / "pitcher" / prop,
        root / prop,  # last-resort
    ]

def _features_path_for(prop: str) -> Path:
    """
    Per-prop features JSON. Only honors FEATURE_META_PATH_<prop>.
    Then searches the prop folder for common names or any *features*.json.
    """
    # 🔒 Only per-prop override is allowed (prevents 'hits' bleed-over)
    env = os.getenv(f"FEATURE_META_PATH_{prop}")
    if env:
        p = Path(env).resolve()
        if not p.exists():
            raise FileNotFoundError(f"Feature meta file not found: {p}")
        return p

    root = _models_root()
    folder = root / "batter" / prop

    # Preferred full-name conventions
    cands = [
        folder / f"features_{prop}_v1.json",
        folder / f"{prop}_features_v1.json",
    ]
    for p in cands:
        if p.exists():
            return p

    # Legacy / abbreviated fallbacks (pick most recent *features*.json)
    if folder.exists():
        any_json = sorted(folder.glob("*features*.json"))
        if any_json:
            any_json.sort(key=lambda x: x.stat().st_mtime, reverse=True)
            return any_json[0]

    raise FileNotFoundError(
        f"No features file for '{prop}'. Looked in {folder}. "
        f"Set FEATURE_META_PATH_{prop} to override."
    )

def _model_path_for(prop: str) -> Path:
    """
    Per-prop model path. Honors only MODEL_FILE_<prop>.
    Then looks in <ROOT>/batter/<prop> for a sensible joblib.
    """
    env = os.getenv(f"MODEL_FILE_{prop}")
    if env:
        p = Path(env).resolve()
        if p.exists():
            return p
        raise FileNotFoundError(f"MODEL_FILE_{prop} not found: {p}")

    folder = _models_root() / "batter" / prop
    # Preferred full-name convention
    cands = [
        folder / f"{prop}_poisson_v1.joblib",
    ]
    for p in cands:
        if p.exists():
            return p

    # Fallback: most-recent *.joblib in the prop folder
    if folder.exists():
        joblibs = sorted(folder.glob("*.joblib"))
        if joblibs:
            joblibs.sort(key=lambda x: x.stat().st_mtime, reverse=True)
            return joblibs[0]

    raise FileNotFoundError(
        f"No model file for '{prop}' in {folder}. "
        f"Set MODEL_FILE_{prop} to override."
    )

# -----------------------------
# Feature utilities
# -----------------------------
def _load_feature_names(prop: str) -> List[str]:
    """
    Load the ordered feature names from the per-prop JSON.
    Accept any of these keys: feature_names, features, ordered_feature_names, columns
    or a dict-of-props with <prop>.columns.
    """
    p = _features_path_for(prop)
    data = json.loads(p.read_text())

    if isinstance(data, dict):
        for k in ("feature_names", "features", "ordered_feature_names", "columns"):
            v = data.get(k)
            if isinstance(v, list):
                return list(v)
        # Also allow nested mapping: {"hits": {"columns": [...]}, ...}
        if prop in data and isinstance(data[prop], dict):
            v = data[prop].get("columns")
            if isinstance(v, list):
                return list(v)
        raise ValueError(f"Could not find a list of features in {p}")
    elif isinstance(data, list):
        return list(data)
    else:
        raise ValueError(f"Unsupported feature meta format in {p}")

def _coerce_scalar(v: Any) -> float:
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().lower()
    if s in {"true", "t", "yes", "y"}:
        return 1.0
    if s in {"false", "f", "no", "n"}:
        return 0.0
    try:
        return float(s)
    except Exception:
        return 0.0

def _vector_from_features(features: Dict[str, Any], ordered_names: List[str]) -> List[float]:
    """
    Build a numeric vector for the model, filling missing with 0.0,
    preserving the exact order expected by training.
    """
    return [_coerce_scalar(features.get(name)) for name in ordered_names]

# -----------------------------
# API models
# -----------------------------
class PredictInput(BaseModel):
    prop_type: str
    features: Dict[str, Any]
    # Optional legacy fields tolerated but unused here
    player_id: Optional[int] = None
    team_id: Optional[int] = None
    game_id: Optional[int] = None

# -----------------------------
# Routes
# -----------------------------
@router.get("/featureMeta/{prop_type}")
async def feature_meta(prop_type: str):
    """
    Debug helper: report which features file was loaded and the names/count.
    Mirrors your existing response shape.
    """
    try:
        path = _features_path_for(prop_type)
        cols = _load_feature_names(prop_type)
        return {
            "prop_type": prop_type,
            "meta_path": str(path),
            "feature_names": cols,
            "count": len(cols),
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to load feature meta for '{prop_type}': {e}")

@router.post("/predict")
async def predict(req: Request) -> Dict[str, Any]:
    payload = await req.json()
    inp = PredictInput(**payload)

    # Resolve artifacts
    try:
        feature_names = _load_feature_names(inp.prop_type)
    except Exception as e:
        raise HTTPException(500, f"Failed to load features: {e}")

    try:
        model_path = _model_path_for(inp.prop_type)
    except Exception as e:
        raise HTTPException(404, f"Model file not found for prop_type '{inp.prop_type}': {e}")

    # Fill missing with zeros for model input; also capture what's actually missing
    orig = dict(inp.features or {})
    missing_features = [name for name in feature_names if name not in orig]
    base = {name: 0 for name in feature_names}
    base.update(orig)

    X = [_vector_from_features(base, feature_names)]

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

    # Mint commit token (carry full prepared payload so /props/add can insert)
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
        "features_used": len(feature_names),
        "missing_features": missing_features,
        "missing_count": len(missing_features),
        "commit_token": commit_token,
    }
