# backend/scripts/prediction/make_prediction.py

from typing import Dict, Any, List, Optional
import sys, json
import numpy as np
import pandas as pd

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

def _predict_core(prop_in: str, feats_in: Dict[str, Any]) -> Dict[str, Any]:
    if not prop_in:
        raise ValueError("prop_type is required")

    prop = canonicalize_prop_type(prop_in)

    # 1) Column order from metadata (fallback to incoming keys if missing)
    try:
        feature_list = get_expected_features(prop, prefer="random_forest")
        if not feature_list:
            feature_list = list(feats_in.keys())
    except Exception:
        feature_list = list(feats_in.keys())

    # 2) Build a DataFrame (NOT a bare numpy array)
    X = _vectorize_features_df(feats_in, feature_list)

    # 3) Lazy-load models
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

    # 4) Predict + blend
    p_lr = _predict_proba(lr, X)
    p_rf = _predict_proba(rf, X)
    p_blend = _blend_probs(p_lr, p_rf)

    # 5) Clamp and add compatibility fields for the API/UI
    p_over = float(min(max(p_blend, 0.0), 1.0))
    result = {
        "prop_type": prop,
        "prob": p_over,                         # ← what /predict normalizer looks for
        "probability": p_over,                  # ← also provided for compatibility
        "probability_over": p_over,
        "probability_under": float(1.0 - p_over),
        "components": {
            "lr": None if p_lr is None else float(p_lr),
            "rf": None if p_rf is None else float(p_rf),
        },
        "feature_count": len(feature_list),
        "used_features": feature_list,
        "model": "blend(lr,rf)" if (lr and rf) else ("logistic_regression" if lr else "random_forest"),
    }
    return result

# --- Public API expected by /api/predict (module path call) ---
def predict(*, prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    """
    Preferred entrypoint used by backend/app/routes/api/predict.py
    """
    return _predict_core(prop_type, features)

# --- Compatibility wrapper (old call style) ---
def make_prediction(*args, **kwargs) -> Dict[str, Any]:
    """
    Backward compatibility:
      - make_prediction(payload_dict)
      - or make_prediction(prop_type=..., features=...)
    """
    if args and isinstance(args[0], dict) and not kwargs:
        payload = args[0]
        return _predict_core(payload.get("prop_type"), payload.get("features") or {})
    # kwargs style
    return _predict_core(kwargs.get("prop_type"), kwargs.get("features") or {})

# --- Subprocess/CLI support (used by fallback path) ---
if __name__ == "__main__":
    # read {"prop_type":"...","features":{...}} from stdin, write JSON to stdout
    try:
        payload = json.loads(sys.stdin.read())
        out = _predict_core(payload.get("prop_type"), payload.get("features") or {})
        sys.stdout.write(json.dumps(out))
    except Exception as e:
        sys.stderr.write(str(e))
        sys.exit(1)
