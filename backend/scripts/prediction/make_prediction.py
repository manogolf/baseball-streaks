# backend/scripts/prediction/make_prediction.py
import math
import numpy as np
from typing import Dict, Any
from app.services.model_registry import (
    canonicalize_prop_type,
    get_expected_features,
    load_model,
)

def _build_vector(prop_type: str, incoming: Dict[str, Any]) -> np.ndarray:
    expected = get_expected_features(prop_type)  # default RF list
    vec = []
    for name in expected:
        val = incoming.get(name, 0.0)  # you can choose to 422 instead of defaulting
        if isinstance(val, bool): val = int(val)
        try:
            num = float(val)
        except (TypeError, ValueError):
            raise ValueError(f"Feature '{name}' not numeric (got {val!r})")
        if math.isinf(num) or math.isnan(num):
            raise ValueError(f"Feature '{name}' invalid (NaN/Inf)")
        vec.append(num)
    return np.array([vec], dtype=float)

def make_prediction(payload: Dict[str, Any]) -> Dict[str, Any]:
    # canonicalize
    prop_type = canonicalize_prop_type(payload["prop_type"])
    features  = payload["features"]

    X = _build_vector(prop_type, features)

    rf = load_model(prop_type, "random_forest")
    lr = load_model(prop_type, "logistic_regression")

    p_rf = float(rf.predict_proba(X)[0][1])
    p_lr = float(lr.predict_proba(X)[0][1])
    p = round((p_rf + p_lr) / 2, 4)

    rec = "over" if p >= 0.5 else "under"
    return {
        "probability": p,
        "recommendation": rec,
        "predicted_outcome": rec,
        "confidence_score": p,
    }
