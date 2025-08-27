# backend/scripts/prediction/make_prediction.py

import joblib
import os, json
import sys, numpy as np
import pandas as pd
import math

from typing import Dict, Any, List, Optional
from pathlib import Path
from backend.app.services.model_registry import (
    canonicalize_prop_type,
    load_model,
    get_expected_features,
)

# Make sure the repo root is on sys.path (…/project/src)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

    # Columns that are identifiers/provenance, not model features
_EXCLUDE_KEYS = {
    "player_id", "team_id", "game_id", "game_date",
    "prop_type", "over_under", "prop_value",
    "prop_source", "created_at", "updated_at", "ingested_at",
}

def _columns_from_features_dict(features: Dict[str, Any]) -> List[str]:
    """
    Infer the model input columns from the enriched features (MV row):
      - include all base numeric/string features (minus IDs/provenance)
      - add isna__<base> for each base
      - ensure 'streak_type' exists (categorical expected by the pipeline)
    """
    base = [k for k in features.keys() if k not in _EXCLUDE_KEYS]
    cols = set(base)
    for b in base:
        cols.add(f"isna__{b}")
    cols.add("streak_type")
    # Deterministic order (pipeline uses names; order won't matter, but keep stable)
    return sorted(cols)


DEBUG = os.getenv("DEBUG_PREDICT") not in (None, "", "0", "false", "False")

def _is_missing(v) -> bool:
    return v is None or v == "" or (isinstance(v, float) and math.isnan(v))

def _vectorize(features: Dict[str, Any], feature_list: List[str]) -> pd.DataFrame:
    """
    Build a 1-row DataFrame whose columns exactly match `feature_list`.
    Special handling:
      - 'isna__<base>' columns are generated from missingness of `<base>`
      - 'streak_type' remains a string category (default 'none')
      - everything else coerced to float with fallback 0.0
    """
    row: Dict[str, Any] = {}
    for col in feature_list:
        if col.startswith("isna__"):
            base = col.split("__", 1)[1]
            v = features.get(base, None)
            row[col] = 1.0 if _is_missing(v) else 0.0
        elif col == "streak_type":
            v = features.get("streak_type", None)
            # if caller passed streak_type_hot/cold flags, synthesize a label
            if v is None:
                hot = features.get("streak_type_hot")
                cold = features.get("streak_type_cold")
                if hot in (1, True, "1", "true"): v = "hot"
                elif cold in (1, True, "1", "true"): v = "cold"
                else: v = "none"
            row[col] = str(v)
        else:
            v = features.get(col, 0)
            try:
                row[col] = float(v)
            except Exception:
                row[col] = 0.0
    return pd.DataFrame([row], columns=feature_list)

def _input_columns_for(prop: str) -> list[str] | None:
    """
    Prefer the input column list stored in the model artifact's meta.
    This list matches what the pipeline expects (e.g., 'isna__*', raw categoricals).
    """
    try:
        p = Path("/var/data/models/latest") / f"{prop}.joblib"
        if p.exists():
            obj = joblib.load(p)
            meta = obj.get("meta") if isinstance(obj, dict) else None
            if meta:
                # try a few common keys
                for key in ("input_columns", "expected_input_columns", "features_in", "expected_columns"):
                    cols = meta.get(key)
                    if cols:
                        return list(cols)
    except Exception:
        pass
    try:
        # last resort (older artifacts). may not include isna__/categoricals
        return get_expected_features(prop, prefer="random_forest")
    except Exception:
        return None

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
    except Exception as e:  # <-- bind as e
        # helpful log so we see column/schema issues instead of silent 0.5s
        print(f"[predict] {type(model).__name__} failed: {e}", file=sys.stderr, flush=True)
        return None
    return None

def _blend(a: Optional[float], b: Optional[float]) -> float:
    xs = [x for x in (a, b) if x is not None]
    return sum(xs) / len(xs) if xs else 0.5

def predict(*, prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    """Main entry for in-process import."""
    prop = canonicalize_prop_type(prop_type)

    # 1) expected columns (prefer artifact meta if present; else infer from DB-enriched features)
    feat_cols = _input_columns_for(prop) or _columns_from_features_dict(features)
    if not feat_cols:
        feat_cols = get_expected_features(prop, prefer="random_forest") or []

    # 2) strictly-filtered DF in correct order (no extra cols!)
    X = _vectorize(features, feat_cols)
    ...

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
        "probability": p_over,
        "probability_under": 1.0 - p_over,
        "components": {"lr": p_lr, "rf": p_rf},
        "feature_count": len(feat_cols),
        "used_features": feat_cols,
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
