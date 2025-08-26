# backend/scripts/prediction/make_prediction.py
from __future__ import annotations

import os, sys, json
from typing import Dict, Any, List, Optional, Tuple

import numpy as np
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

def _vectorize_and_inspect(features: Dict[str, Any], feature_list: List[str]) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Build a 1-row DataFrame with columns EXACTLY matching training order.
    Missing/invalid -> 0.0. Also returns quick diagnostics.
    """
    vals: List[float] = []
    missing_keys: List[str] = []
    non_numeric_keys: List[str] = []
    for f in feature_list:
        v = features.get(f, 0)
        if v in (None, ""):
            missing_keys.append(f)
            v = 0
        try:
            vals.append(float(v))
        except Exception:
            non_numeric_keys.append(f)
            vals.append(0.0)

    X = pd.DataFrame([vals], columns=feature_list)
    nonzero = int(np.count_nonzero(vals))
    diags = {
        "expected": len(feature_list),
        "sent": len(feature_list),
        "nonzero": nonzero,
        "missing": len(missing_keys),
        "non_numeric": len(non_numeric_keys),
        "missing_keys": missing_keys[:10],       # cap to avoid noisy logs
        "non_numeric_keys": non_numeric_keys[:10]
    }
    return X, diags

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
    feat_list = get_expected_features(prop, prefer="random_forest")

    # 2) strictly-filtered DF in correct order (no extra cols!) + quick diags
    X, diags = _vectorize_and_inspect(features, feat_list)

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

    # Optional one-line debug (stderr so we don't break API JSON)
    if DEBUG:
        print(
            f"[predict] prop={prop} expected={diags['expected']} nonzero={diags['nonzero']} "
            f"missing={diags['missing']} non_numeric={diags['non_numeric']} "
            f"p_lr={p_lr} p_rf={p_rf} p={p_over}",
            file=sys.stderr,
            flush=True,
        )
        if diags["missing"] > 0:
            print(f"[predict] missing_keys(sample)={diags['missing_keys']}", file=sys.stderr, flush=True)

    return {
        "prop_type": prop,
        "probability_over": p_over,
        "probability": p_over,                 # convenience
        "probability_under": 1.0 - p_over,
        "components": {"lr": p_lr, "rf": p_rf},
        "feature_count": len(feat_list),
        "used_features": feat_list,
        "diagnostics": diags,                  # 👈 lightweight, helps the UI/API inspect
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
