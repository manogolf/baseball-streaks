# File: backend/scripts/modeling/backfill_predictions.py
"""
Backfills model predictions into the `model_training_props` table.

- Loads RF + LR models from persistent disk (MODEL_DIR)
- Builds feature vectors with build_feature_vector(...)
- Blends probabilities (RF+LR) to set predicted_outcome + confidence_score
- Updates only predicted_outcome, confidence_score, was_correct, prediction_timestamp
- Touches only mlb_api, resolved rows where predicted_outcome IS NULL

NOTE: No Supabase Storage calls. Disk-only models.
"""

import os
import pandas as pd
import numpy as np
import joblib
from time import perf_counter
from datetime import datetime, timezone
from collections import defaultdict
from dotenv import load_dotenv
from pathlib import Path
from supabase import create_client
from build_feature_vector import build_feature_vector

# ──────────────────────────────────────────────────────────────────────────────
# Env & clients
# ──────────────────────────────────────────────────────────────────────────────
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

MODEL_DIR = os.getenv("MODEL_DIR", "/var/data/models")
Path(MODEL_DIR).mkdir(parents=True, exist_ok=True)

raw_bs = int(os.getenv("BACKFILL_BATCH_SIZE", "500"))
# (hard clamp optional; raise or lower as you wish)
BATCH_SIZE = max(1, raw_bs)

ENV_PROP_TYPES = os.getenv("PROP_TYPES")
ENV_PROP_TYPES = [p.strip() for p in ENV_PROP_TYPES.split(",")] if ENV_PROP_TYPES else None

# Map DB prop_type -> model folder/file prefix on disk
PROP_TYPE_ALIASES = {
    "rbis": "rbis",
    "rbi": "rbis",
    "runs": "runs_scored",
}

# ──────────────────────────────────────────────────────────────────────────────
# Deep scalar normalization (fixes "truth value of a Series is ambiguous")
# ──────────────────────────────────────────────────────────────────────────────
def _scalarize(x):
    """Return a plain Python scalar (or None) from pandas/numpy/list wrappers."""
    # pandas
    if isinstance(x, pd.Series):
        return _scalarize(x.iloc[0] if not x.empty else None)
    if isinstance(x, pd.DataFrame):
        return _scalarize(x.iloc[0, 0] if not x.empty else None)
    # numpy
    if isinstance(x, np.ndarray):
        return _scalarize(x.flat[0]) if x.size else None
    if isinstance(x, np.generic):
        return x.item()
    # python sequences
    if isinstance(x, (list, tuple)) and len(x) == 1:
        return _scalarize(x[0])
    return x

def _normalize_row(row) -> dict:
    """Row may be dict-like or pandas Series; returns a dict of scalars only."""
    if hasattr(row, "to_dict"):
        row = row.to_dict()
    elif isinstance(row, pd.Series):
        row = row.to_dict()
    elif not isinstance(row, dict):
        # Supabase rows are usually dicts; if not, try best-effort conversion
        row = dict(row)
    # deep scalarize
    out = {}
    for k, v in row.items():
        if isinstance(v, (dict,)):
            out[k] = {kk: _scalarize(vv) for kk, vv in v.items()}
        else:
            out[k] = _scalarize(v)
    # ensure key fields are scalars
    for k in ("id", "player_id", "game_id", "team", "player_name", "outcome", "prop_type"):
        if k in out:
            out[k] = _scalarize(out[k])
    return out

# ──────────────────────────────────────────────────────────────────────────────
# Model I/O (disk-only) + cache
# ──────────────────────────────────────────────────────────────────────────────
def model_type_for(db_type: str) -> str:
    return PROP_TYPE_ALIASES.get(db_type, db_type)

def _model_filename(model_prop_type: str, kind: str) -> str:
    return f"{model_prop_type}_{'random_forest' if kind == 'rf' else 'logistic_regression'}.pkl"

def _model_path(model_prop_type: str, kind: str) -> str:
    folder = os.path.join(MODEL_DIR, model_prop_type)
    Path(folder).mkdir(parents=True, exist_ok=True)
    return os.path.join(folder, _model_filename(model_prop_type, kind))

def models_available(model_prop_type: str) -> tuple[bool, list[str]]:
    missing = []
    rf_path = _model_path(model_prop_type, "rf")
    lr_path = _model_path(model_prop_type, "lr")
    if not os.path.exists(rf_path): missing.append(rf_path)
    if not os.path.exists(lr_path): missing.append(lr_path)
    return (len(missing) == 0, missing)

_MODEL_CACHE: dict[str, tuple[object, object]] = {}

def load_models(model_prop_type: str):
    if model_prop_type in _MODEL_CACHE:
        return _MODEL_CACHE[model_prop_type]
    ok, missing = models_available(model_prop_type)
    if not ok:
        raise FileNotFoundError(f"Models missing for {model_prop_type}: {', '.join(missing)}")
