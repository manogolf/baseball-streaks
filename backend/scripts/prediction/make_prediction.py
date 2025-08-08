# backend/scripts/prediction/make_prediction.py
import math
import numpy as np
import pandas as pd
from typing import Dict, Any
from app.services.model_registry import (
    canonicalize_prop_type,
    get_expected_features,
    load_model,
)

def _build_frame(prop_type: str, incoming: Dict[str, Any]) -> pd.DataFrame:
    expected = get_expected_features(prop_type)
    row = {}
    for name in expected:
        val = incoming.get(name, 0.0)  # choose 0.0 default or raise
        if isinstance(val, bool):
            val = int(val)
        try:
            num = float(val)
        except (TypeError, ValueError):
            raise ValueError(f"Feature '{name}' not numeric (got {val!r})")
        if math.isinf(num) or math.isnan(num):
            raise ValueError(f"Feature '{name}' invalid (NaN/Inf)")
        row[name] = num
    return pd.DataFrame([row], columns=expected)

def make_prediction(payload: Dict[str, Any]) -> Dict[str, Any]:
    prop_type = canonicalize_prop_type(payload["prop_type"])
    features  = payload["features"]

    # one canonical frame
    X = _build_frame(prop_type, features)

    rf = load_model(prop_type, "random_forest")
    lr = load_model(prop_type, "logistic_regression")

    # align to the model’s training columns if they’re recorded
    X_rf = X
    if hasattr(rf, "feature_names_in_"):
        X_rf = X.reindex(columns=list(rf.feature_names_in_), fill_value=0.0)

    X_lr = X
    if hasattr(lr, "feature_names_in_"):
        X_lr = X.reindex(columns=list(lr.feature_names_in_), fill_value=0.0)

    p_rf = float(rf.predict_proba(X_rf)[0][1])
    p_lr = float(lr.predict_proba(X_lr)[0][1])
    p = round((p_rf + p_lr) / 2, 4)

    rec = "over" if p >= 0.5 else "under"
    return {
        "probability": p,
        "recommendation": rec,
        "predicted_outcome": rec,
        "confidence_score": p,
    }
