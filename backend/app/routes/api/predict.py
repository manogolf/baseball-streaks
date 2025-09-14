# backend/app/routes/api/predict.py
from __future__ import annotations

import os, json, joblib
import math

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from pathlib import Path
from app.security.commit_token import mint_commit_token, verify_commit_token
from app.config import COMMIT_TOKEN_SECRET, COMMIT_TOKEN_TTL

try:
    from backend.scripts.shared.supabase_utils import supabase
except Exception:
    try:
        from scripts.shared.supabase_utils import supabase  # fallback
    except Exception:
        supabase = None

router = APIRouter()

# -----------------------------
# Models/Features discovery (no ml.* imports)
# -----------------------------
def _models_root() -> Path:
    env = os.getenv("MODELS_ROOT") or os.getenv("MODELS_DIR") or os.getenv("MODEL_DIR")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[4] / "ml" / "models"


def _prop_folders(prop: str) -> List[Path]:
    """
    Look for models/features under a VAR root (first), then the repo.
    Under the VAR root, also scan release subfolders like: props/, latest/, v*/ , backup_*/ , archive/
    """
    # VAR first (your canonical store)
    env = os.getenv("MODELS_ROOT") or os.getenv("MODELS_DIR") or os.getenv("MODEL_DIR") or "/var/data/models"
    var_root = Path(env).resolve()

    # repo fallback
    repo_root = Path(__file__).resolve().parents[4] / "ml" / "models"

    def candidates_for_root(root: Path) -> List[Path]:
        cand: List[Path] = []
        # top-level common layouts
        cand += [
            root / "props" / "batter" / prop,
            root / "props" / "pitcher" / prop,
            root / "props" / prop,  # flat
            root / "batter" / prop,
            root / "pitcher" / prop,
            root / prop,
        ]
        # release subfolders (latest/, vYYYYMMDD..., backup_..., archive/)
        if root.exists():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    name = child.name.lower()
                    if name in {"latest"} or name.startswith("v") or "backup" in name or "archive" in name:
                        cand += [
                            child / "batter" / prop,
                            child / "pitcher" / prop,
                            child / "props" / "batter" / prop,
                            child / "props" / "pitcher" / prop,
                            child / "props" / prop,
                            child / prop,
                        ]
            except Exception:
                pass
        return cand

    folders: List[Path] = []
    folders += candidates_for_root(var_root)
    if repo_root != var_root:
        folders += candidates_for_root(repo_root)
    return folders

def _features_path_for(prop: str) -> Path:
    # env override
    env = os.getenv(f"FEATURE_META_PATH_{prop}") or os.getenv("FEATURE_META_PATH")
    if env:
        p = Path(env).resolve()
        if not p.exists():
            raise FileNotFoundError(f"Feature meta file not found: {p}")
        return p

    tag = os.getenv("FEATURE_SET_TAG", "v1")

    # prefer "<prop>_features_<tag>.json" then "<prop>_features.json"
    for folder in _prop_folders(prop):
        p = folder / f"{prop}_features_{tag}.json"
        if p.exists():
            return p
        p = folder / f"{prop}_features.json"
        if p.exists():
            return p

    # fallback: globs, prefer files containing _{tag}
    def pick_best(cands: List[Path]) -> Optional[Path]:
        if not cands:
            return None
        if tag:
            for c in cands:
                if f"_{tag}." in c.name:
                    return c
        return sorted(cands)[-1]

    tried: List[str] = []
    glob_patterns = [
        f"{prop}_features_*.json",
        f"features_{prop}_*.json",
        "*features*.json",
        "*.json",
    ]

    for folder in _prop_folders(prop):
        if not folder.exists():
            continue
        matches: List[Path] = []
        for pat in glob_patterns:
            tried.append(str(folder / pat))
            matches.extend(folder.glob(pat))
        best = pick_best(matches)
        if best:
            return best

    raise FileNotFoundError(
        f"No features file for '{prop}'. Tried: {', '.join(tried)} "
        f"(or set FEATURE_META_PATH[_{prop}])."
    )

def _model_path_for(prop: str) -> Path:
    env = os.getenv(f"MODEL_FILE_{prop}") or os.getenv("MODEL_FILE")
    if env:
        p = Path(env).resolve()
        if p.exists():
            return p
        raise FileNotFoundError(f"MODEL_FILE for '{prop}' not found: {p}")
    for folder in _prop_folders(prop):
        preferred = folder / f"{prop}_poisson_v1.joblib"
        if preferred.exists():
            return preferred
        if folder.exists():
            joblibs = [j for j in folder.glob("*.joblib") if j.is_file()]
            if joblibs:
                joblibs.sort(key=lambda x: x.stat().st_mtime, reverse=True)
                return joblibs[0]
    tried = []
    for folder in _prop_folders(prop):
        tried.append(str(folder / f"{prop}_poisson_v1.joblib"))
        tried.append(str(folder / "*.joblib"))
    raise FileNotFoundError(
        f"No model file for '{prop}'. Tried {', '.join(tried)} (or set MODEL_FILE[_{prop}])."
    )

def _read_feature_names_from_file(p: Path, prop: str) -> List[str]:
    """
    Parse a features JSON file into an ordered list of column names.
    Accepts several common schemas and nested {prop: {columns: [...]}}.
    """
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

def _features_path_adjacent_to_model(model_path: Path, prop: str) -> Optional[Path]:
    """
    Prefer a features JSON stored *next to* the selected model.
    This keeps the feature spec paired with the trained pipeline.
    """
    try:
        folder = model_path.parent
    except Exception:
        return None

    tag = (os.getenv("FEATURE_SET_TAG") or "").strip()
    tried: List[str] = []
    patterns = [
        f"{prop}_features_{tag}.json" if tag else None,
        f"{prop}_features.json",
        f"features_{prop}_{tag}.json" if tag else None,
        f"features_{prop}.json",
        "*features*.json",
        "*.json",
    ]
    for pat in [p for p in patterns if p]:
        cands = [f for f in folder.glob(pat) if "calibrator" not in f.name.lower()]
        tried.append(str(folder / pat))
        if cands:
            # if tag is set, prefer a name containing _{tag}.
            if tag:
                tagged = [c for c in cands if f"_{tag}." in c.name]
                if tagged:
                    return tagged[0]
            return sorted(cands)[-1]
    return None

def _poisson_over_prob(mu: float, line: float) -> float:
    """
    Convert a Poisson mean (mu) into P(X > line) for sportsbook-style lines.
    For half lines (n+0.5), this is P(X >= n+1).
    For integer lines (n), this is P(X >= n+1).
    """
    if mu <= 0 or not math.isfinite(mu):
        return 0.0

    # threshold k = smallest integer strictly greater than line
    if abs(line - round(line)) < 1e-9:
        k = int(round(line)) + 1
    else:
        k = int(math.floor(line)) + 1
    k = max(1, k)

    # P(X >= k) = 1 - P(X <= k-1) with X~Poisson(mu)
    # compute CDF up to k-1 via stable iterative terms
    term = math.exp(-mu)  # i = 0
    cdf = term
    for i in range(1, k):
        term *= mu / i
        cdf += term
    p = 1.0 - cdf
    return max(0.0, min(1.0, p))

# -----------------------------
# API models
# -----------------------------
class PredictInput(BaseModel):
    prop_type: str
    features: Dict[str, Any] = {}
    player_id: Optional[int] = None
    team_id: Optional[int] = None
    game_id: Optional[int] = None
    # allow the client to pass line + context for commit
    prop_value: Optional[float] = None      # e.g., 0.5
    over_under: Optional[str] = None        # "over" | "under"
    team_abbr: Optional[str] = None         # e.g., "NYY"
    game_date: Optional[str] = None         # "YYYY-MM-DD"

# -----------------------------
# Feature utilities (embedded)
# -----------------------------
def _load_feature_names(prop: str) -> List[str]:
    """
    Load the ordered feature names from the per-prop JSON.
    Accept any of these keys: feature_names, features, ordered_feature_names, columns
    or a dict-of-props with <prop>.columns.
    """
    p = _features_path_for(prop)
    data = json.loads(p.read_text())

    if isinstance(data, dict):
        for k in ("feature_names", "features", "ordered_feature_names", "columns"):
            v = data.get(k)
            if isinstance(v, list):
                return list(v)
        # Also allow nested mapping: {"hits": {"columns": [...]}, ...}
        if prop in data and isinstance(data[prop], dict):
            v = data[prop].get("columns")
            if isinstance(v, list):
                return list(v)
        raise ValueError(f"Could not find a list of features in {p}")
    elif isinstance(data, list):
        return list(data)
    else:
        raise ValueError(f"Unsupported feature meta format in {p}")

def _fetch_precomputed_features(prop_type: str, player_id: int | str, game_id: int | str, tag: str = "v1"):
    """
    Return the precomputed features dict for (prop_type, player_id, game_id, tag),
    or None if not found. Works with either 'features_json' or 'features' column.
    """
    if supabase is None:
        return None
    try:
        res = (
            supabase
            .from_("prop_features_precomputed")
            .select("features, features_json")
            .eq("prop_type", prop_type)
            .eq("player_id", str(player_id))
            .eq("game_id", str(game_id))
            .eq("feature_set_tag", tag)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", None) or []
        if not rows:
            return None
        row = rows[0]
        feats = row.get("features_json") or row.get("features")
        return feats if isinstance(feats, dict) else None
    except Exception:
        return None

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

def _vector_from_features(features: Dict[str, Any], ordered_names: List[str]) -> List[float]:
    """
    Build a numeric vector for the model, filling missing with 0.0,
    preserving the exact order expected by training.
    """
    return [_coerce_scalar(features.get(name)) for name in ordered_names]

# -----------------------------
# Routes
# -----------------------------
@router.get("/featureMeta/{prop_type}")
async def feature_meta(prop_type: str):
    """
    Report which features file will be used (prefer the JSON adjacent to the model),
    and list the names/count.
    """
    try:
        # 1) Try to resolve the model so we can pick the paired spec
        model_path = None
        try:
            model_path = _model_path_for(prop_type)
        except Exception:
            model_path = None  # still allow fallback

        # 2) Prefer a features file adjacent to the chosen model; else fallback discovery
        if model_path:
            adj = _features_path_adjacent_to_model(model_path, prop_type)
        else:
            adj = None

        if adj is not None:
            cols = _read_feature_names_from_file(adj, prop_type)
            meta_path = adj
        else:
            p = _features_path_for(prop_type)
            cols = _read_feature_names_from_file(p, prop_type)  # consistent parser
            meta_path = p

        return {
            "prop_type": prop_type,
            "meta_path": str(meta_path),
            "feature_names": cols,
            "count": len(cols),
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to load feature meta for '{prop_type}': {e}")

@router.post("/predict")
async def predict(req: Request) -> Dict[str, Any]:
    payload = await req.json()
    inp = PredictInput(**payload)

    # 1 Resolve the model FIRST (so we can pair its adjacent feature spec)
    try:
        model_path = _model_path_for(inp.prop_type)
    except Exception as e:
        raise HTTPException(404, f"Model file not found for prop_type '{inp.prop_type}': {e}")

    # 2 Choose feature names, preferring a JSON next to the selected model; fallback to discovery
    try:
        adj = _features_path_adjacent_to_model(model_path, inp.prop_type)
        if adj is not None:
            feature_names = _read_feature_names_from_file(adj, inp.prop_type)
        else:
            feature_names = _load_feature_names(inp.prop_type)
    except Exception as e:
        raise HTTPException(500, f"Failed to load features: {e}")

    # 3 Fast path: pull precomputed features if we have ids
    tag = os.getenv("FEATURE_SET_TAG", "v1")
    pid_attr = getattr(inp, "player_id", None)
    gid_attr = getattr(inp, "game_id", None)
    pre = None
    if pid_attr is not None and gid_attr is not None:
        pre = _fetch_precomputed_features(inp.prop_type, pid_attr, gid_attr, tag=tag)

    # Merge order: precomputed base, then request overrides
    merged_features: Dict[str, Any] = {}
    if isinstance(pre, dict):
        merged_features.update(pre)
    if isinstance(inp.features, dict):
        merged_features.update(inp.features)

    # 4 Resolve/load model  (unchanged right above)
    try:
        model = joblib.load(str(model_path))
    except Exception as e:
        raise HTTPException(500, f"Failed to load model: {e}")

    # 5 Predict
    try:
        model_name = model_path.name.lower()
        is_poisson = "poisson" in model_name

        if hasattr(model, "predict_proba") and not is_poisson:
            proba = float(model.predict_proba(X)[0][1])
        else:
            y = model.predict(X)
            val = float(y[0]) if isinstance(y, (list, tuple)) else float(y)
            if is_poisson:
                line = float(inp.prop_value) if inp.prop_value is not None else 0.5
                proba = _poisson_over_prob(max(0.0, val), line)
            else:
                # fallback for regressors that directly emit a prob
                proba = val

        # sanity clamp
        proba = max(0.0, min(1.0, proba))
    except Exception as e:
        raise HTTPException(500, f"Inference failed: {e}")

    # --- build token payload from merged features first (so /props/add has what it needs) ---
    f = merged_features  # shorthand

    def _to_int(x):
        try: return int(x)
        except: return None

    def _to_float(x):
        try: return float(x)
        except: return None

    pid = _to_int(f.get("player_id")) or _to_int(getattr(inp, "player_id", None)) or 0
    gid = _to_int(f.get("game_id"))   or _to_int(getattr(inp, "game_id", None))   or 0
    team_id = _to_int(f.get("team_id")) or _to_int(getattr(inp, "team_id", None))

    game_date = f.get("game_date") or getattr(inp, "game_date", None)
    if isinstance(game_date, str):
        game_date = game_date[:10]  # YYYY-MM-DD

    prop_value = f.get("prop_value")
    if prop_value is None:
        prop_value = f.get("line")  # legacy alias
    prop_value = _to_float(prop_value)

    over_under = (f.get("over_under") or getattr(inp, "over_under", None) or "over")

    team_abbr = f.get("team") or getattr(inp, "team_abbr", None)
    team_abbr = (str(team_abbr).upper() if team_abbr else None)

    token_features = {
        "player_id": pid,
        "team_id": team_id,
        "game_id": gid,
        "game_date": game_date,
        "prop_type": inp.prop_type,
        "prop_value": prop_value,
        "over_under": over_under,
        "team": team_abbr,
        # useful context (optional in props/add)
        "probability": float(proba),
        "is_home": f.get("is_home"),
        "opponent_encoded": f.get("opponent_encoded"),
        "game_time": f.get("game_time"),
        "game_day_of_week": f.get("game_day_of_week"),
        "time_of_day_bucket": f.get("time_of_day_bucket"),
        "opponent": f.get("opponent"),
        "starting_pitcher_id": f.get("starting_pitcher_id"),
    }

    # Mint token with these features (NOT the numeric vector)
    commit_token = mint_commit_token(
        prob=float(proba),
        prop_type=inp.prop_type,
        features=token_features,
        ttl_seconds=COMMIT_TOKEN_TTL,
        secret=COMMIT_TOKEN_SECRET,
    )

    # normalize to str
    if isinstance(commit_token, dict):
        commit_token = commit_token.get("token") or commit_token.get("commit_token")
    if isinstance(commit_token, bytes):
        commit_token = commit_token.decode("utf-8")
    if not isinstance(commit_token, str) or not commit_token:
        raise HTTPException(500, "mint_commit_token returned unexpected type")

    # verify with the SAME secret
    try:
        verify_commit_token(commit_token, secret=COMMIT_TOKEN_SECRET)
    except TypeError:
        import app.security.commit_token as ct
        setattr(ct, "COMMIT_TOKEN_SECRET", COMMIT_TOKEN_SECRET)
        verify_commit_token(commit_token)
    except Exception as e:
        raise HTTPException(500, f"Internal token round-trip failed: {e}")

    return {
        "prop_type": inp.prop_type,
        "model": model_path.name,
        "probability": proba,
        "features_used": len(feature_names),
        "missing_features": missing_features,
        "missing_count": len(missing_features),
        "commit_token": commit_token,
    }
