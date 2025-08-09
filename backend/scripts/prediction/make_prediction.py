# backend/scripts/prediction/make_prediction.py

from typing import Dict, Any, List, Optional
import numpy as np

from app.services.model_registry import (
    canonicalize_prop_type,
    load_model,
    get_expected_features,  # returns per-prop feature list (prefers RF list)
)

def _vectorize_features(features: Dict[str, Any], feature_list: List[str]) -> np.ndarray:
    """Build a 2D numpy array in the exact order expected by the model."""
    row = []
    for f in feature_list:
        v = features.get(f)
        try:
            row.append(float(v) if v is not None else 0.0)
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
    if hasattr(model, "predict"):
        pred = model.predict(X)
        return float(pred[0]) if isinstance(pred[0], (int, float)) else None
    return None

def _blend_probs(p_lr: Optional[float], p_rf: Optional[float]) -> float:
    """Simple average blend of available probabilities."""
    parts = [p for p in (p_lr, p_rf) if p is not None]
    return sum(parts) / len(parts) if parts else 0.5

def make_prediction(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Expects {"prop_type": str, "features": dict}
    Returns:
      - probability_over
      - probability (alias of probability_over)
      - probability_under
      - components (lr, rf)
      - feature_count, used_features
    """
    prop_in = payload.get("prop_type")
    feats_in = payload.get("features") or {}
    if not prop_in:
        raise ValueError("prop_type is required")

    prop = canonicalize_prop_type(prop_in)
    feature_list = get_expected_features(prop, prefer="random_forest")
    X = _vectorize_features(feats_in, feature_list)

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

    p_lr = _predict_proba(lr, X)
    p_rf = _predict_proba(rf, X)
    p_lr_f = float(p_lr) if p_lr is not None else None
    p_rf_f = float(p_rf) if p_rf is not None else None

    p_over = float(_blend_probs(p_lr_f, p_rf_f))
    p_under = float(1.0 - p_over)

    return {
        "prop_type": prop,
        "probability": p_over,  # alias
        "probability_over": p_over,
        "probability_under": p_under,
        "components": {"lr": p_lr_f, "rf": p_rf_f},
        "feature_count": len(feature_list),
        "used_features": feature_list,
    }
