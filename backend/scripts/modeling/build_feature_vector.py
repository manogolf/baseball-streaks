# backend/scripts/modeling/build_feature_vector.py

from __future__ import annotations
import json
import os
from pathlib import Path
from typing import Any, Dict, List

# Resolve models dir relative to this file
MODELS_DIR = Path(os.getenv("MODELS_DIR", str(Path(__file__).resolve().parents[2] / "models")))
META_PATH  = Path(os.getenv("FEATURE_META_PATH", str(MODELS_DIR / "feature_metadata.json")))

# Load ordered feature names once
with META_PATH.open("r", encoding="utf-8") as f:
    meta = json.load(f)

if isinstance(meta, dict):
    if "feature_names" in meta:
        FEATURE_NAMES: List[str] = list(meta["feature_names"])
    elif "features" in meta and isinstance(meta["features"], list):
        FEATURE_NAMES = list(meta["features"])
    elif "ordered_feature_names" in meta:
        FEATURE_NAMES = list(meta["ordered_feature_names"])
    elif "columns" in meta and isinstance(meta["columns"], list):
        FEATURE_NAMES = list(meta["columns"])
    else:
        FEATURE_NAMES = []
else:
    FEATURE_NAMES = list(meta)

def _coerce_scalar(v: Any) -> float:
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().lower()
    if s in {"true", "t", "yes", "y"}:
        return 1.0
    if s in {"false", "f", "no", "n"}:
        return 0.0
    try:
        return float(s)
    except Exception:
        return 0.0

def build_feature_vector(features: Dict[str, Any]) -> List[float]:
    """
    Pure, DB-free builder: order and coerce values to match training metadata.
    Missing keys default to 0.0.
    """
    return [_coerce_scalar(features.get(name)) for name in FEATURE_NAMES]
