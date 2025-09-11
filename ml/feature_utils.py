# ml/feature_utils.py
from __future__ import annotations
from pathlib import Path
from typing import Any, Dict, List
import os, json

# -------- Root location for all model artifacts (no envs required) ----------
def _models_root() -> Path:
    """
    Priority:
      1) MODELS_ROOT / MODELS_DIR / MODEL_DIR (if you *choose* to set them)
      2) repo default: <repo>/ml/models
    """
    env = os.getenv("MODELS_ROOT") or os.getenv("MODELS_DIR") or os.getenv("MODEL_DIR")
    if env:
        return Path(env).resolve()
    # ml/feature_utils.py -> parents[1] is <repo>/ml, parents[2] is <repo>
    return Path(__file__).resolve().parents[1] / "models"

def _prop_folders(prop: str) -> List[Path]:
    root = _models_root()
    return [
        root / "batter" / prop,
        root / "pitcher" / prop,
        root / prop,  # last-resort
    ]

# -------- Feature meta discovery (per-prop) ----------
def features_path_for(prop: str) -> Path:
    """
    Search for a per-prop features JSON next to the model.
    No env vars, no global meta files.
    Looks for (in each candidate folder):
      - features_<prop>_v1.json
      - <prop>_features_v1.json
      - any features*.json (fallback)
    """
    for folder in _prop_folders(prop):
        cands = [
            folder / f"features_{prop}_v1.json",
            folder / f"{prop}_features_v1.json",
        ]
        for p in cands:
            if p.exists():
                return p
        if folder.exists():
            any_feats = sorted(folder.glob("features*.json"))
            if any_feats:
                return any_feats[0]
    tried = []
    for folder in _prop_folders(prop):
        tried.append(str(folder / f"features_{prop}_v1.json"))
        tried.append(str(folder / f"{prop}_features_v1.json"))
        tried.append(str(folder / "features*.json"))
    raise FileNotFoundError(
        f"No features file for '{prop}'. Tried: {', '.join(tried)}."
    )

def load_feature_names(prop: str) -> List[str]:
    """
    Load ordered feature names from the per-prop JSON.
    Accept keys: feature_names, features, ordered_feature_names, columns
    or nested mapping: { "<prop>": { "columns": [...] } }
    """
    p = features_path_for(prop)
    data = json.loads(p.read_text())

    if isinstance(data, dict):
        for k in ("feature_names", "features", "ordered_feature_names", "columns"):
            v = data.get(k)
            if isinstance(v, list):
                return list(v)
        if prop in data and isinstance(data[prop], dict):
            v = data[prop].get("columns")
            if isinstance(v, list):
                return list(v)
        raise ValueError(f"Could not find a list of features in {p}")
    elif isinstance(data, list):
        return list(data)
    else:
        raise ValueError(f"Unsupported feature meta format in {p}")

# -------- Vectorization helpers ----------
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

def vector_from_features(features: Dict[str, Any], ordered_names: List[str]) -> List[float]:
    """Build numeric vector (missing→0.0) in the exact training order."""
    return [_coerce_scalar(features.get(name)) for name in ordered_names]
