# backend/app/services/model_registry.py

import os, json, math, tempfile, threading
from typing import Any, List, Dict
import requests
from joblib import load as joblib_load
from supabase import create_client

# ---- Supabase client (service role) ----
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
_supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# ---- Caches ----
_lock = threading.Lock()
_MODEL_CACHE: Dict[tuple[str,str], Any] = {}      # (prop_type, algo) -> model
_FEATURE_META: Dict[str, Any] | None = None       # memoized JSON
_CANON: Dict[str, str] | None = None              # alias -> canonical

# Where your metadata file lives relative to app root
_FEATURE_METADATA_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "modeling", "feature_metadata.json")
)

# ---- Canonical map (expand as needed) ----
def _canonical_map() -> Dict[str, str]:
    global _CANON
    if _CANON is not None:
        return _CANON
    # canonical → itself
    canon = {
        "hits":"hits","singles":"singles","doubles":"doubles","triples":"triples",
        "home_runs":"home_runs","rbis":"rbis","runs_scored":"runs_scored","walks":"walks",
        "strikeouts_batting":"strikeouts_batting","total_bases":"total_bases","stolen_bases":"stolen_bases",
        "hits_runs_rbis":"hits_runs_rbis","runs_rbis":"runs_rbis",
        "strikeouts_pitching":"strikeouts_pitching","walks_allowed":"walks_allowed",
        "earned_runs":"earned_runs","hits_allowed":"hits_allowed","outs_recorded":"outs_recorded",
    }
    # aliases (left side) -> canonical (right side)
    aliases = {
        "hr":"home_runs","home run":"home_runs","hrr":"hits_runs_rbis",  # example
        "runs+rbi":"runs_rbis","runs rbis":"runs_rbis","runs rbi":"runs_rbis",
        "h+r+rbi":"hits_runs_rbis","hrrr":"hits_runs_rbis",              # add what you actually see
    }
    # fold to lowercase keys
    _CANON = {**{k:k for k in canon}, **{k.lower():v for k,v in aliases.items()}}
    return _CANON

def canonicalize_prop_type(s: str) -> str:
    m = _canonical_map()
    key = (s or "").strip().lower()
    if key in m:
        return m[key]
    if key in m.values():  # already canonical
        return key
    raise ValueError(f"Unknown prop_type '{s}'")

# ---- Feature metadata ----
def load_feature_metadata() -> Dict[str, Any]:
    global _FEATURE_META
    if _FEATURE_META is not None:
        return _FEATURE_META
    with open(_FEATURE_METADATA_PATH, "r") as f:
        _FEATURE_META = json.load(f)
    return _FEATURE_META

def get_expected_features(prop_type: str, prefer: str = "random_forest") -> List[str]:
    meta = load_feature_metadata().get(prop_type)
    if not meta:
        raise ValueError(f"No feature metadata for prop_type '{prop_type}'")
    feats = meta.get(prefer) or meta.get("logistic_regression")
    if not feats:
        raise ValueError(f"No feature list for prop_type '{prop_type}'")
    return feats

# ---- Model loader (Supabase Storage) ----
def _download_from_supabase(bucket: str, path: str) -> bytes:
    res = _supabase.storage.from_(bucket).create_signed_url(path, 3600)
    url = res["signedURL"]
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    return r.content

def load_model(prop_type: str, algo: str) -> Any:
    """algo should be 'random_forest' or 'logistic_regression'"""
    key = (prop_type, algo)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]
    with _lock:
        if key in _MODEL_CACHE:
            return _MODEL_CACHE[key]
        # match your naming: {prop}/{prop}_{algo}_compressed.pkl
        rel = f"{prop_type}/{prop_type}_{algo}_compressed.pkl"
        blob = _download_from_supabase("models", rel)
        with tempfile.NamedTemporaryFile(delete=True) as tmp:
            tmp.write(blob); tmp.flush()
            model = joblib_load(tmp.name)
        _MODEL_CACHE[key] = model
        return model
