# backend/scripts/prediction/make_prediction.py
from __future__ import annotations

import sys, json
from typing import Dict, Any, List, Optional

import numpy as np
import pandas as pd

from app.services.model_registry import (
    canonicalize_prop_type,
    load_model,
    get_expected_features,
)

try:
    from app.services.model_registry import (
        canonicalize_prop_type, load_model, get_expected_features
    )
except ModuleNotFoundError:
    from backend.app.services.model_registry import (
        canonicalize_prop_type, load_model, get_expected_features
    )

def _vectorize(features: Dict[str, Any], feature_list: List[str]) -> pd.DataFrame:
    """1-row DataFrame with columns EXACTLY matching training order; missing -> 0."""
    vals: List[float] = []
    for f in feature_list:
        v = features.get(f, 0)
        try:
            vals.append(float(v))
        except Exception:
            vals.append(0.0)
    return pd.DataFrame([vals], columns=feature_list)

def _p(model, X: pd.DataFrame) -> Optional[float]:
    if model is None:
        return None
    if hasattr(model, "predict_proba"):
        return float(model.predict_proba(X)[0][1])
    if hasattr(model, "predict"):
        y = model.predict(X)
        try:
            return float(np.ravel(y)[0])
        except Exception:
            return None
    return None

def _blend(a: Optional[float], b: Optional[float]) -> float:
    xs = [x for x in (a, b) if x is not None]
    return sum(xs) / len(xs) if xs else 0.5

def predict(*, prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    """Main entry for in-process import."""
    prop = canonicalize_prop_type(prop_type)

    # 1) expected columns (from metadata aligned to training)
    feat_list = get_expected_features(prop, prefer="random_forest")

    # 2) strictly-filtered DF in correct order (no extra cols!)
    X = _vectorize(features, feat_list)

    # 3) load models (disk-first, supabase fallback if configured)
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

    # 4) predict + blend
    p_lr = _p(lr, X)
    p_rf = _p(rf, X)
    p_over = max(0.0, min(1.0, _blend(p_lr, p_rf)))

    return {
        "prop_type": prop,
        "probability_over": p_over,
        "probability": p_over,                 # convenience
        "probability_under": 1.0 - p_over,
        "components": {"lr": p_lr, "rf": p_rf},
        "feature_count": len(feat_list),
        "used_features": feat_list,
        "model": "blend(lr,rf)",
    }

# Subprocess mode: read stdin JSON and print JSON to stdout.
def make_prediction(*, prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    # alias for older call-site names
    return predict(prop_type=prop_type, features=features)

if __name__ == "__main__":
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        out = predict(
            prop_type=payload.get("prop_type") or payload.get("propType"),
            features=payload.get("features") or {},
        )
        sys.stdout.write(json.dumps(out))
    except Exception as e:
        sys.stderr.write(str(e))
        sys.exit(1)
