# backend/scripts/prediction/make_prediction.py

from typing import Dict, Any, List, Optional
import numpy as np

# Use the canonicalization + model/feature helpers you already have
from app.services.model_registry import (
    canonicalize_prop_type,
    load_model,
    get_expected_features,      # returns per-prop feature list (prefers RF list)
)

def _vectorize_features(features: Dict[str, Any], feature_list: List[str]) -> np.ndarray:
    """
    Build a 2D numpy array in the exact order expected by the model.
    Missing features -> 0. Numeric-cast when possible, else 0.
    """
    row = []
    for f in feature_list:
        v = features.get(f)
        try:
            if v is None:
                row.append(0.0)
            else:
                # allow ints, floats, string numerics
                row.append(float(v))
        except (ValueError, TypeError):
            row.append(0.0)
    return np.array([row], dtype=float)

def _predict_proba(model, X: np.ndarray) -> Optional[float]:
    """Return probability of class 1 if available, else None."""
    if model is None:
        return None
    if hasattr(model, "predict_proba"):
        proba = model.predict_proba(X)
        return float(proba[0][1])
    # fallback for models without predict_proba
    if hasattr(model, "predict"):
        pred = model.predict(X)
        return float(pred[0]) if isinstance(pred[0], (int, float)) else None
    return None

def _blend_probs(p_lr: Optional[float], p_rf: Optional[float]) -> float:
    parts = [p for p in (p_lr, p_rf) if p is not None]
    if not parts:
        # If both are missing, caller will raise; keep return sane
        return 0.5
    # simple average; adjust later if you want weighting
    return sum(parts) / len(parts)

def make_prediction(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Expects {"prop_type": str, "features": dict}
    Returns a dict the API can hand straight back to the client.
    """
    prop_in = payload.get("prop_type")
    feats_in = payload.get("features") or {}
    if not prop_in:
        raise ValueError("prop_type is required")

    prop = canonicalize_prop_type(prop_in)  # raises on unknown

    # 1) Feature order (from metadata). Prefer RF’s list; fallback inside helper.
    feature_list = get_expected_features(prop, prefer="random_forest")

    # 2) Vectorize in the exact order
    X = _vectorize_features(feats_in, feature_list)

    # 3) Lazy-load models from disk (or Supabase fallback) on demand
    lr = rf = None
    try:
        lr = load_model(prop, "logistic_regression")
    except Exception:
        lr = None
    try:
        rf = load_model(prop, "random_forest")
    except Exception:
        rf = None

    if not (lr or rf):
        raise RuntimeError(f"No models available for prop_type '{prop}'")

    # 4) Get probabilities, blend
    p_lr = _predict_proba(lr, X)
    p_rf = _predict_proba(rf, X)
    p_blend = _blend_probs(p_lr, p_rf)

    return {
        "prop_type": prop,
        "probability_over": p_blend,
        "components": {"lr": p_lr, "rf": p_rf},
        "feature_count": len(feature_list),
        "used_features": feature_list,  # helpful for debugging/traceability
    }
