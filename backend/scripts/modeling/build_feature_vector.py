# backend/scripts/modeling/build_feature_vector.py

from __future__ import annotations
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Iterable

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

def load_feature_names(meta_path: str | Path) -> list[str]:
    p = Path(meta_path)
    with p.open("r", encoding="utf-8") as f:
        meta = json.load(f)
    if isinstance(meta, dict):
        for key in ("feature_names", "features", "ordered_feature_names", "columns"):
            if key in meta and isinstance(meta[key], list):
                return list(meta[key])
    # if file is already a simple list
    if isinstance(meta, list):
        return list(meta)
    return []

def build_feature_vector_for(features: Dict[str, Any], names: Iterable[str]) -> list[float]:
    return [_coerce_scalar(features.get(name)) for name in names]