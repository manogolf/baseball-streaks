#  ml/feature_utils.py

from __future__ import annotations
from pathlib import Path
from typing import Any, Dict, List
import os, json
import logging
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# --- logging (optional but helpful) ---
log = logging.getLogger("precompute")
if not log.handlers:
    logging.basicConfig(level=logging.INFO)

# --- one shared HTTP session with retries/backoff ---
_SESSION = requests.Session()
_RETRY = Retry(
    total=3,
    backoff_factor=0.6,               # 0.6s, 1.2s, 1.8s
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods={"GET"},
    respect_retry_after_header=True,
)
_ADAPTER = HTTPAdapter(max_retries=_RETRY, pool_connections=20, pool_maxsize=20)
_SESSION.mount("https://", _ADAPTER)
_SESSION.headers.update({"User-Agent": "Proppadia-Precompute/1.0"})

_DEFAULT_TIMEOUT = (3.05, 10)  # (connect, read) seconds

def _get(url: str, timeout=_DEFAULT_TIMEOUT):
    """GET JSON with sane timeouts/retries; return None on failure."""
    try:
        resp = _SESSION.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except requests.Timeout:
        log.warning("Timeout fetching %s", url)
        return None
    except requests.RequestException as e:
        log.warning("HTTP error fetching %s: %s", url, e)
        return None
    except ValueError:
        log.warning("Non-JSON response from %s", url)
        return None

# --- update _people_stats to guard None ---
def _people_stats(person_id, group="hitting", types=None):
    types = types or ["last7", "last15", "last30"]
    # build your URL exactly as before...
    url = f"https://statsapi.mlb.com/api/v1/people/{person_id}/stats?group={group}&stats={','.join(types)}"
    data = _get(url)
    # Always return a safe shape so callers don't hang on bad data
    return data or {"stats": []}

def _models_root() -> Path:
    env = os.getenv("MODELS_ROOT") or os.getenv("MODELS_DIR") or os.getenv("MODEL_DIR")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[1] / "models"

def _prop_folders(prop: str) -> List[Path]:
    root = _models_root()
    return [
        root / "batter" / prop,
        root / "pitcher" / prop,
        root / prop,
    ]


def features_path_for(prop: str, feature_tag: str = "v1") -> Path:
    """
    Looks for a features file for `prop` across batter/pitcher folders.
    Accepts several filename shapes, e.g.:
      - features_<prop>_v1.json
      - <prop>_features_v1.json
      - <prop>_features.json
      - features_<prop>.json
      - features.json
    Search order (first hit wins):
      1) ml/models/batter/<prop>/
      2) ml/models/pitcher/<prop>/
      3) ml/models/<prop>/            (generic fallback)
    If exact matches missing, falls back to glob matches and prefers `<feature_tag>`
    if present, otherwise returns the lexicographically last match.
    """
    root = Path(__file__).resolve().parents[1]  # repo root
    base = root / "ml" / "models"

    search_dirs = [
        base / "batter" / prop,
        base / "pitcher" / prop,
        base / prop,
    ]

    # Precise filenames we’ll try first
    exact_names = []
    if feature_tag:
        exact_names += [
            f"features_{prop}_{feature_tag}.json",
            f"{prop}_features_{feature_tag}.json",
        ]
    exact_names += [
        f"{prop}_features.json",
        f"features_{prop}.json",
        "features.json",
    ]

    tried = []

    # 1) Try exact filenames in priority order
    for d in search_dirs:
        for name in exact_names:
            p = d / name
            tried.append(str(p))
            if p.exists():
                return p

    # 2) Fall back to globs, prefer tag if available, else pick last lexicographically
    def pick_best(candidates):
        if not candidates:
            return None
        if feature_tag:
            for c in candidates:
                if f"_{feature_tag}." in c.name:
                    return c
        return sorted(candidates)[-1]

    glob_patterns = [
        f"{prop}_features_*.json",
        f"features_{prop}_*.json",
        "features_*.json",
        "*.json",
    ]

    for d in search_dirs:
        if not d.exists():
            continue
        matches = []
        for pat in glob_patterns:
            matches.extend(d.glob(pat))
        best = pick_best(matches)
        if best:
            return best

    # 3) Nothing found → raise with helpful info
    raise FileNotFoundError(
        f"No features file for '{prop}'. Tried: {', '.join(tried)}."
    )

def load_feature_names(prop: str) -> List[str]:
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

def _coerce_scalar(v: Any) -> float:
    if v is None: return 0.0
    if isinstance(v, bool): return 1.0 if v else 0.0
    if isinstance(v, (int, float)): return float(v)
    s = str(v).strip().lower()
    if s in {"true","t","yes","y"}: return 1.0
    if s in {"false","f","no","n"}: return 0.0
    try: return float(s)
    except Exception: return 0.0

def vector_from_features(features: Dict[str, Any], ordered_names: List[str]) -> List[float]:
    return [_coerce_scalar(features.get(name)) for name in ordered_names]
