# backend/scripts/modeling/transform_features.py

import os
import json
import pandas as pd
import numpy as np

MODEL_DIR = os.getenv("MODEL_DIR", "/var/data/models")
_FEATURE_META = None

def _load_feature_meta() -> dict:
    global _FEATURE_META
    if _FEATURE_META is not None:
        return _FEATURE_META
    path = os.path.join(MODEL_DIR, "feature_metadata.json")
    with open(path, "r") as f:
        _FEATURE_META = json.load(f)
    return _FEATURE_META

def _expected_columns_pair_from_meta(prop_type: str) -> tuple[list[str], list[str]]:
    """
    Return (rf_cols, lr_cols) from feature_metadata.json.
    Supports:
      { "prop": ["..."] }
      { "prop": {"columns":[...] } }
      { "prop": {"random_forest":[...], "logistic_regression":[...] } }
      { "columns":[...] }  # global fallback
    """
    meta = _load_feature_meta()
    entry = meta.get(prop_type, meta.get("columns"))

    if isinstance(entry, list):
        cols = list(entry)
        return cols, cols

    if isinstance(entry, dict):
        if isinstance(entry.get("columns"), list):
            cols = list(entry["columns"])
            return cols, cols
        rf = entry.get("random_forest")
        lr = entry.get("logistic_regression")
        if isinstance(rf, list) and isinstance(lr, list):
            return list(rf), list(lr)
        if isinstance(rf, list):
            return list(rf), list(rf)
        if isinstance(lr, list):
            return list(lr), list(lr)

    # Fallback to empty lists (backfill script will handle erroring if needed)
    return [], []

def _safe_setcol(df: pd.DataFrame, col: str, value):
    """Create or overwrite a column without KeyError."""
    if col in df.columns:
        df[col] = value
    else:
        df.loc[:, col] = value

def _coerce_numeric_fill(df: pd.DataFrame) -> pd.DataFrame:
    for c in df.columns:
        if df[c].dtype == object:
            try:
                df[c] = pd.to_numeric(df[c], errors="coerce")
            except Exception:
                pass
    return df.replace([np.inf, -np.inf], 0).fillna(0)

def transform_features(df: pd.DataFrame, debug: bool = False, *args, **kwargs) -> pd.DataFrame:
    """
    Minimal, robust transformer:
    - Accepts debug kwarg for compatibility.
    - Ensures all expected feature columns for this prop_type exist.
    - Leaves existing values intact; missing features start at 0.
    - Coerces to numeric & fills NaN/±inf with 0.
    """
    if not isinstance(df, pd.DataFrame):
        df = pd.DataFrame(df)
    if df.empty:
        return df

    # Pull prop_type (support scalar or Series)
    prop_type = None
    if "prop_type" in df.columns:
        v = df["prop_type"].iloc[0]
        prop_type = str(v) if v is not None else None

    rf_cols, lr_cols = _expected_columns_pair_from_meta(prop_type or "")
    expected = sorted(set(rf_cols) | set(lr_cols))

    # Pre-create expected columns (default 0); keep existing values
    for col in expected:
        if col not in df.columns:
            _safe_setcol(df, col, 0)

    # Coerce to numeric & fill bad values
    df = _coerce_numeric_fill(df)

    # Return as-is; caller (backfill_predictions.py) will strictly reindex per model.
    return df
