# backend/scripts/prediction/make_prediction.py
from __future__ import annotations

import os, sys, json
from typing import Dict, Any, List, Optional

import sys, numpy as np
import pandas as pd

from backend.app.services.model_registry import (
    canonicalize_prop_type,
    load_model,
    get_expected_features,
)

# Make sure the repo root is on sys.path (…/project/src)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

DEBUG = os.getenv("DEBUG_PREDICT") not in (None, "", "0", "false", "False")

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

def _p(model, X) -> Optional[float]:
    if model is None:
        return None
    try:
        if hasattr(model, "predict_proba"):
            proba = model.predict_proba(X)
            return float(proba[0][1])
        if hasattr(model, "predict"):
            y = model.predict(X)
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
    feat_rf = get_expected_features(prop, prefer="random_forest")
    feat_lr = get_expected_features(prop, prefer="logistic_regression")
    # 2) strictly-filtered DF in correct order (no extra cols!)
    X_rf = _vectorize(features, feat_rf)
    X_lr = _vectorize(features, feat_lr)

    if os.getenv("DEBUG_PREDICT") not in (None, "", "0", "false", "False"):
   
        print(
            f"[predict] prop={prop} rf_expected={len(feat_rf)} rf_nonzero={int(np.count_nonzero(X_rf.to_numpy()))} "
            f"lr_expected={len(feat_lr)} lr_nonzero={int(np.count_nonzero(X_lr.to_numpy()))}",
            file=sys.stderr, flush=True
    )

    # small diagnostics
    if DEBUG:
        nz_rf = int(np.count_nonzero(X_rf.to_numpy()))
        nz_lr = int(np.count_nonzero(X_lr.to_numpy()))
        print(f"[predict] prop={prop} rf_expected={len(feat_rf)} rf_nonzero={nz_rf} "
            f"lr_expected={len(feat_lr)} lr_nonzero={nz_lr}", file=sys.stderr, flush=True)

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
    p_lr = _p(lr, X_lr)
    p_rf = _p(rf, X_rf)    
    p_over = max(0.0, min(1.0, _blend(p_lr, p_rf)))

    if DEBUG:
        print(f"[predict] p_lr={p_lr} p_rf={p_rf} p={p_over}", file=sys.stderr, flush=True)

    return {
        "prop_type": prop,
        "probability_over": p_over,
        "probability": p_over,
        "probability_under": 1.0 - p_over,
        "components": {"lr": p_lr, "rf": p_rf},
        "feature_count": len(feat_rf),   # was len(feat_list)
        "used_features": feat_rf,        # was feat_list
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
