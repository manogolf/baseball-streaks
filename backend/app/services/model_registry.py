# backend/app/services/model_registry.py

import os, json, tempfile, threading, requests
from typing import Any, List, Dict, Optional
from pathlib import Path
from joblib import load as joblib_load

# ── Optional Supabase client (initialized only if env vars exist) ──────────────
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
_supabase = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client
        _supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception:
        _supabase = None  # don’t crash if the lib/env isn’t available

# ── Paths ─────────────────────────────────────────────────────────────────────
MODEL_DIR = Path(os.getenv("MODEL_DIR", "/var/data/models")).resolve()
_REPO_FEATURE_METADATA_PATH = Path(__file__).resolve().parents[3] / "backend" / "scripts" / "modeling" / "feature_metadata.json"
# If your repo layout differs, adjust the ^ path; disk copy takes precedence anyway.

# ── Caches ────────────────────────────────────────────────────────────────────
_lock = threading.Lock()
_MODEL_CACHE: Dict[tuple[str, str], Any] = {}     # (prop_type, algo) -> model
_FEATURE_META: Optional[Dict[str, Any]] = None
_CANON: Optional[Dict[str, str]] = None

# ── Canonicalization ──────────────────────────────────────────────────────────
def _canonical_map() -> Dict[str, str]:
    global _CANON
    if _CANON is not None:
        return _CANON
    canon = {
        "hits":"hits","singles":"singles","doubles":"doubles","triples":"triples",
        "home_runs":"home_runs","rbis":"rbis","runs_scored":"runs_scored","walks":"walks",
        "strikeouts_batting":"strikeouts_batting","total_bases":"total_bases","stolen_bases":"stolen_bases",
        "hits_runs_rbis":"hits_runs_rbis","runs_rbis":"runs_rbis",
        "strikeouts_pitching":"strikeouts_pitching","walks_allowed":"walks_allowed",
        "earned_runs":"earned_runs","hits_allowed":"hits_allowed","outs_recorded":"outs_recorded",
    }
    aliases = {
        "hr":"home_runs","home run":"home_runs",
        "runs+rbi":"runs_rbis","runs rbis":"runs_rbis","runs rbi":"runs_rbis",
        "h+r+rbi":"hits_runs_rbis","hrr":"hits_runs_rbis","hrrr":"hits_runs_rbis",
    }
    _CANON = {**{k: k for k in canon}, **{k.lower(): v for k, v in aliases.items()}}
    return _CANON

def canonicalize_prop_type(s: str) -> str:
    key = (s or "").strip().lower()
    m = _canonical_map()
    if key in m:
        return m[key]
    if key in m.values():
        return key
    raise ValueError(f"Unknown prop_type '{s}'")

# ── Feature metadata (disk-first, fallback to repo) ────────────────────────────
def _feature_metadata_path() -> Path:
    disk_meta = MODEL_DIR / "feature_metadata.json"
    return disk_meta if disk_meta.exists() else _REPO_FEATURE_METADATA_PATH

def load_feature_metadata() -> Dict[str, Any]:
    global _FEATURE_META
    if _FEATURE_META is not None:
        return _FEATURE_META
    meta_path = _feature_metadata_path()
    with open(meta_path, "r") as f:
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

# ── Download from Supabase (used only if disk-miss and client available) ──────
def _download_from_supabase(bucket: str, path: str) -> bytes:
    if not _supabase:
        raise RuntimeError("Supabase client not available for fallback download.")
    res = _supabase.storage.from_(bucket).create_signed_url(path, 3600)
    url = res["signedURL"]
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return r.content

# ── Disk-first model loader with LR suffix flexibility & Supabase fallback ────
LR_SUFFIX_CANDIDATES = ["logistic_regression_compressed.pkl", "log_reg_compressed.pkl"]

def _disk_model_path_candidates(prop_type: str, algo: str) -> List[Path]:
    if algo == "logistic_regression":
        return [(MODEL_DIR / prop_type / f"{prop_type}_{s}").resolve() for s in LR_SUFFIX_CANDIDATES]
    # Random Forest is fixed name
    return [(MODEL_DIR / prop_type / f"{prop_type}_{algo}_compressed.pkl").resolve()]

def load_model(prop_type: str, algo: str) -> Any:
    """
    Lazy-load a single model.
      1. Try disk candidates under $MODEL_DIR/{prop}/
      2. Fallback to Supabase 'models/{prop}/{prop}_{algo}_compressed.pkl' (if configured),
         and persist to disk for next time.
    Cached by (prop_type, algo).
    """
    key = (prop_type, algo)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    with _lock:
        if key in _MODEL_CACHE:
            return _MODEL_CACHE[key]

        # 1 Disk
        for p in _disk_model_path_candidates(prop_type, algo):
            if p.exists():
                model = joblib_load(str(p))
                _MODEL_CACHE[key] = model
                return model

        # 2 Supabase fallback
        rel = f"{prop_type}/{prop_type}_{algo}_compressed.pkl"
        blob = _download_from_supabase("models", rel)  # raises if _supabase missing

        # Persist to first candidate path (so future loads are disk-native)
        target = _disk_model_path_candidates(prop_type, algo)[0]
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as f:
                f.write(blob)
            model = joblib_load(str(target))
        except Exception:
            with tempfile.NamedTemporaryFile(delete=True) as tmp:
                tmp.write(blob); tmp.flush()
                model = joblib_load(tmp.name)

        _MODEL_CACHE[key] = model
        return model
