# backend/scripts/prediction/make_prediction.py

from typing import Dict, Any, List, Optional
import numpy as np
import pandas as pd  # 👈 add this

from app.services.model_registry import (
    canonicalize_prop_type,
    load_model,
    get_expected_features,
)

def _vectorize_features_df(features: Dict[str, Any], feature_list: List[str]) -> pd.DataFrame:
    """
    Build a 1-row pandas DataFrame with columns in the exact order expected by the model.
    Missing/invalid -> 0. Cast to float where possible.
    """
    row = []
    for f in feature_list:
        v = features.get(f)
        try:
            row.append(0.0 if v is None else float(v))
        except (ValueError, TypeError):
            row.append(0.0)
    # preserve column names to silence sklearn warnings and ensure alignment
    return pd.DataFrame([row], columns=feature_list)

def _predict_proba(model, X) -> Optional[float]:
    """Return P(class==1) if available; fallback to predict()."""
    if model is None:
        return None
    if hasattr(model, "predict_proba"):
        proba = model.predict_proba(X)
        return float(proba[0][1])
    if hasattr(model, "predict"):
        pred = model.predict(X)
        return float(pred[0]) if isinstance(pred[0], (int, float, np.floating)) else None
    return None

def _blend_probs(p_lr: Optional[float], p_rf: Optional[float]) -> float:
    parts = [p for p in (p_lr, p_rf) if p is not None]
    return sum(parts) / len(parts) if parts else 0.5

def make_prediction(payload: Dict[str, Any]) -> Dict[str, Any]:
    prop_in = payload.get("prop_type")
    feats_in = payload.get("features") or {}
    if not prop_in:
        raise ValueError("prop_type is required")

    prop = canonicalize_prop_type(prop_in)

    # 1) Column order from metadata
    feature_list = get_expected_features(prop, prefer="random_forest")

    # 2) Build a DataFrame (NOT a bare numpy array)
    X = _vectorize_features_df(feats_in, feature_list)

    # 3) Lazy-load models
    lr = rf = None
    try:
        lr = load_model(prop, "logistic_regression")
    except Exception:
        pass
    try:
        rf = load_model(prop, "random_forest")
    except Exception:
        pass
    if not (lr or rf):
        raise RuntimeError(f"No models available for prop_type '{prop}'")

    # 4) Predict + blend
    p_lr = _predict_proba(lr, X)
    p_rf = _predict_proba(rf, X)
    p_blend = _blend_probs(p_lr, p_rf)

    # 5) Clamp and add compatibility fields for the frontend
    p_over = float(min(max(p_blend, 0.0), 1.0))
    p_lr_f = None if p_lr is None else float(p_lr)
    p_rf_f = None if p_rf is None else float(p_rf)

    return {
        "prop_type": prop,
        "probability_over": p_over,
        "probability": p_over,                   # 👈 add this for the UI
        "probability_under": float(1.0 - p_over),
        "components": {"lr": p_lr_f, "rf": p_rf_f},
        "feature_count": len(feature_list),
        "used_features": feature_list,
    }
