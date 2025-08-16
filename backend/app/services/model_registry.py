# backend/app/services/model_registry.py

import os, json, threading, requests
from typing import Any, List, Dict, Optional
from pathlib import Path
from joblib import load as joblib_load

# ── Optional Supabase client (only if env vars exist) ─────────────────────────
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
MODELS_DIR = Path(
    os.getenv("MODELS_DIR") or os.getenv("MODEL_DIR") or "/var/data/models"
).resolve()
MODEL_DIR = MODELS_DIR  # back-compat alias

# Repo fallback for legacy metadata (disk copy takes precedence)
_REPO_FEATURE_METADATA_PATH = (
    Path(__file__).resolve().parents[3]
    / "backend" / "scripts" / "modeling" / "feature_metadata.json"
)

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
    # allow both canonical names and common aliases (case-insensitive)
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

# ── Feature metadata (disk-first, then joblib meta, then repo file) ───────────
def _latest_index_path() -> Path:
    return MODELS_DIR / "latest" / "MODEL_INDEX.json"

def _feature_metadata_path() -> Path:
    disk_meta = MODELS_DIR / "feature_metadata.json"
    return disk_meta if disk_meta.exists() else _REPO_FEATURE_METADATA_PATH

def load_feature_metadata() -> Dict[str, Any]:
    """Legacy/global feature metadata fallback."""
    global _FEATURE_META
    if _FEATURE_META is not None:
        return _FEATURE_META
    meta_path = _feature_metadata_path()
    if meta_path.exists():
        with open(meta_path, "r") as f:
            _FEATURE_META = json.load(f)
    else:
        _FEATURE_META = {}
    return _FEATURE_META

def get_expected_features(prop_type: str, prefer: str = "random_forest") -> List[str]:
    prop = canonicalize_prop_type(prop_type)

    # 1) Try latest/MODEL_INDEX.json (written by trainer)
    idx_path = _latest_index_path()
    if idx_path.exists():
        try:
            idx = json.loads(idx_path.read_text())
            entry = idx.get(prop)
            if entry:
                num = entry.get("features_num") or []
                cat = entry.get("features_cat") or []
                if num or cat:
                    return list(num) + list(cat)
        except Exception:
            pass

    # 2) Try reading meta from the model blob
    for p in _disk_candidates(prop, prefer):
        if p.exists():
            try:
                obj = joblib_load(p)
                if isinstance(obj, dict):
                    meta = obj.get("meta") or {}
                    num = meta.get("features_num") or []
                    cat = meta.get("features_cat") or []
                    if num or cat:
                        return list(num) + list(cat)
            except Exception:
                pass

    # 3) Legacy feature_metadata.json
    meta = load_feature_metadata().get(prop)
    if meta:
        feats = meta.get(prefer) or meta.get("logistic_regression")
        if feats:
            return feats

    # 4) Last resort: empty (caller will 0-fill)
    return []

# ── Supabase fallback download (only if disk-miss) ────────────────────────────
def _download_from_supabase(bucket: str, path: str) -> bytes:
    if not _supabase:
        raise RuntimeError("Supabase client not available for fallback download.")
    res = _supabase.storage.from_(bucket).create_signed_url(path, 3600)
    url = res["signedURL"]
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    return r.content

# Optional pin to a specific snapshot (e.g., MODEL_TAG=20250813T200000Z)
MODEL_TAG = os.getenv("MODEL_TAG")

# ── Disk search order (single definition) ─────────────────────────────────────
def _disk_candidates(prop: str, algo: str) -> List[Path]:
    """
    Search order (disk-first):
      1) If MODEL_TAG: /var/data/models/archive/<prop>/<prop>-<TAG>.joblib
      2) /var/data/models/latest/<prop>.joblib
      3) /var/data/models/<prop>/latest.joblib
      4) /var/data/models/<prop>/<algo>.joblib
      5) Legacy PKL names under /var/data/models/<prop>/:
           - <prop>_<algo>.pkl
           - <algo>.pkl
    """
    base = MODELS_DIR
    if MODEL_TAG:
        return [(base / "archive" / prop / f"{prop}-{MODEL_TAG}.joblib").resolve()]
    return [
        (base / "latest" / f"{prop}.joblib").resolve(),
        (base / prop / "latest.joblib").resolve(),
        (base / prop / f"{algo}.joblib").resolve(),
        (base / prop / f"{prop}_{algo}.pkl").resolve(),
        (base / prop / f"{algo}.pkl").resolve(),
    ]

def load_model(prop_type: str, algo: str):
    key = (prop_type, algo)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    with _lock:
        if key in _MODEL_CACHE:
            return _MODEL_CACHE[key]

        tried: List[str] = []

        # 1) Disk-first
        for p in _disk_candidates(prop_type, algo):
            tried.append(str(p))
            if p.exists():
                m = joblib_load(str(p))
                _MODEL_CACHE[key] = m
                return m

        # 2) Optional Supabase fallback (mirror same relative paths)
        if _supabase:
            last_err: Optional[Exception] = None
            for p in _disk_candidates(prop_type, algo):
                try:
                    rel = p.relative_to(MODELS_DIR).as_posix()
                except ValueError:
                    rel = f"{prop_type}/{p.name}"  # conservative fallback
                tried.append(f"supabase://models/{rel}")
                try:
                    blob = _download_from_supabase("models", rel)
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with open(p, "wb") as f:
                        f.write(blob)
                    m = joblib_load(str(p))
                    _MODEL_CACHE[key] = m
                    return m
                except Exception as e:
                    last_err = e
                    continue

        details = "; ".join(tried) or "(no paths attempted)"
        raise RuntimeError(
            f"Model not found for {prop_type}/{algo}. Tried: {details}"
        )
