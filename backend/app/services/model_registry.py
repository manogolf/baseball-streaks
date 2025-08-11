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

# ---- Filename candidates (prefer uncompressed) --------------------------------
LR_SUFFIX_CANDIDATES = [
    "logistic_regression.pkl",
    "log_reg.pkl",
    "logistic_regression.joblib",
    "log_reg.joblib",
    "logistic_regression_compressed.pkl",
    "log_reg_compressed.pkl",
]

RF_SUFFIX_CANDIDATES = [
    "random_forest.pkl",
    "random_forest.joblib",
    "random_forest_compressed.pkl",
]

# ---- Filename candidates (only uncompressed .pkl) ----------------------------
def _model_file_candidates(prop_type: str, algo: str) -> list[Path]:
    if algo == "logistic_regression":
        names = [f"{prop_type}_logistic_regression.pkl"]
    elif algo == "random_forest":
        names = [f"{prop_type}_random_forest.pkl"]
    else:
        names = [f"{prop_type}_{algo}.pkl"]
    return [(MODEL_DIR / prop_type / n).resolve() for n in names]

def load_model(prop_type: str, algo: str) -> Any:
    key = (prop_type, algo)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    with _lock:
        if key in _MODEL_CACHE:
            return _MODEL_CACHE[key]

        tried: list[str] = []

        # 1) Disk-first: exact .pkl names only
        for p in _model_file_candidates(prop_type, algo):
            tried.append(str(p))
            if p.exists():
                model = joblib_load(str(p))
                _MODEL_CACHE[key] = model
                return model

        # 2) Optional Supabase fallback with the *same* filenames
        if _supabase:
            last_err: Exception | None = None
            for p in _model_file_candidates(prop_type, algo):
                rel = f"{prop_type}/{p.name}"  # e.g., home_runs/home_runs_random_forest.pkl
                tried.append(f"supabase://models/{rel}")
                try:
                    blob = _download_from_supabase("models", rel)
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with open(p, "wb") as f:
                        f.write(blob)
                    model = joblib_load(str(p))
                    _MODEL_CACHE[key] = model
                    return model
                except Exception as e:
                    last_err = e
                    continue

        # Nothing worked → raise with what we tried
        details = "; ".join(tried) or "(no paths attempted)"
        raise RuntimeError(f"Model not found for {prop_type}/{algo}. Tried: {details}")
