# backend/app/routes/api/score_prop.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from pathlib import Path
from typing import Optional, Dict, Any, List
from backend.app.services.model_registry import resolve_feature_spec_path
import os, json, math
import joblib
import numpy as np
import pandas as pd
from scipy.stats import poisson

router = APIRouter()

# ---------- request schema ----------
class ScoreReq(BaseModel):
    prop_type: str
    line: float
    # You can pass either a fully-prepared features dict (preferred),
    # or the legacy tuple (player_id, game_date) + have the caller precompute features via /prepareProp
    features: Optional[Dict[str, Any]] = None
    player_id: Optional[int] = None
    game_date: Optional[str] = None


# ---------- helpers ----------
def _base_models_dir() -> Path:
    # Honor MODEL_DIR or MODELS_DIR; default to props layout
    base = os.getenv("MODEL_DIR") or os.getenv("MODELS_DIR") or "/var/data/models/props"
    return Path(base).resolve()

def _prop_dir(prop: str) -> Path:
    # /var/data/models/props/latest/<prop>/
    return _base_models_dir() / "latest" / prop

def _resolve_version_from_latest(md: Path) -> str:
    # md is /.../props/latest/<prop>. We want the real target of 'latest'
    try:
        return md.parent.resolve().name  # vYYYYMMDD after following symlink
    except Exception:
        return "unknown"

def _find_artifacts(prop: str):
    """
    Return (model_path, zero_model_or_None, calibrators_or_None, features_json_or_None, model_dir)
    Prefer new numeric-only names; fall back to older names.
    """
    md = _prop_dir(prop)
    if not md.is_dir():
        raise HTTPException(500, f"Model directory not found: {md}")

    # model (prefer *poisson*.joblib; fall back to lambda/any)
    candidates = [
        *md.glob("*poisson*.joblib"),
        md / "zip_lambda.joblib",
        *md.glob("*lambda*.joblib"),
        *md.glob("*.joblib"),
    ]
    model = next((p for p in candidates if p.exists()), None)
    if model is None:
        listing = sorted(p.name for p in md.glob("*"))
        raise HTTPException(500, f"No model found in {md}; saw: {listing}")

    # optional zero model (ZIP); new flow won’t have one
    zero = next((p for p in [md / "zip_zero.joblib", *md.glob("*zero*.joblib")] if p.exists()), None)

    # features & calibrators (prefix-aware or generic)
    feat = next((p for p in [*md.glob("*_features_v1.json"), md / f"features_{prop}_v1.json"] if p.exists()), None)
    cal  = next((p for p in [*md.glob("*_calibrators_v1.json"), md / f"calibrators_{prop}_v1.json"] if p.exists()), None)

    return model, zero, cal, feat, md

def _load_feature_spec(path: Path) -> List[str]:
    """
    Trainer writes either a list or {"features":[...]}.
    """
    try:
        obj = json.loads(path.read_text())
        if isinstance(obj, dict) and "features" in obj:
            return list(map(str, obj["features"]))
        if isinstance(obj, list):
            return list(map(str, obj))
    except Exception:
        pass
    raise HTTPException(500, f"Invalid features file: {path}")

def _align_numeric_row(features: Dict[str, Any], spec: List[str]) -> pd.DataFrame:
    """
    Keep strictly numeric values; coerce; missing -> 0.0; extra keys ignored.
    """
    row: Dict[str, float] = {}
    for col in spec:
        v = features.get(col, 0.0)
        try:
            row[col] = float(v)
        except Exception:
            row[col] = 0.0
    return pd.DataFrame([row], columns=spec)

def _apply_calibrator_scalar(p: float, cal_path: Path, line: float) -> float:
    """
    Use bag for the requested line key if available; else median of first bag; else identity.
    """
    try:
        obj = json.loads(cal_path.read_text())
        if not isinstance(obj, dict):
            return p
        lines = obj.get("lines") or {}
        key = str(line).replace(".", "_")
        bag = lines.get(key)
        if not bag:
            # fallback to first available bag
            if lines:
                bag = next(iter(lines.values()))
            else:
                return p
        preds = []
        for cal in bag:
            t = cal.get("type", "identity")
            if t == "isotonic":
                x = np.asarray(cal.get("x", []), dtype=float)
                y = np.asarray(cal.get("y", []), dtype=float)
                if x.size >= 2:
                    preds.append(float(np.interp(p, x, y, left=y[0], right=y[-1])))
                else:
                    preds.append(p)
            elif t == "platt":
                z = cal.get("coef", 1.0) * p + cal.get("intercept", 0.0)
                preds.append(float(1.0 / (1.0 + math.exp(-z))))
            else:
                preds.append(p)
        return float(np.median(np.array(preds))) if preds else p
    except Exception:
        return p

def _zip_tail_over(line: float, pi: float, lam: float) -> float:
    """
    P(Y > line) under ZIP (pi = P(structural zero)). If pi==0 → plain Poisson tail.
    """
    k = int(math.floor(line))
    lam = max(1e-9, min(1e9, float(lam)))
    if pi <= 0.0:
        return float(1.0 - poisson.cdf(k, lam))
    t = k + 1
    e = math.exp(-lam)
    p0 = pi + (1.0 - pi) * e
    tail = 1.0 - p0
    pk = (1.0 - pi) * e * lam  # k=1
    for i in range(1, t):
        if i > 1:
            pk *= lam / i
        tail -= pk
    return float(max(0.0, min(1.0, tail)))


# ---------- route ----------
# backend/app/routes/api/score_prop.py (route replacement only)

@router.post("/api/score-prop")
def score_prop(req: ScoreReq):
    from backend.app.services.commit_token import mint_commit_token, features_hash  # local import to avoid cycles

    model_path, zero_path, cal_path, feat_path, md = _find_artifacts(req.prop_type)
    version = _resolve_version_from_latest(md)

    if not req.features:
        raise HTTPException(
            400,
            "Provide 'features' (from /api/prepareProp). "
            "The scorer aligns to the trained numeric feature spec and fills missing with 0.0."
        )

    # --- feature file fallbacks (accept features.json, etc.) ---
    if not feat_path or not feat_path.exists():
        for candidate in (
            md / "features.json",
            md / f"{req.prop_type}_features.json",
            md / f"{req.prop_type}.features.json",
        ):
            if candidate.exists():
                feat_path = candidate
                break

    # last resort: consult model registry’s index-based resolver
    if not feat_path or not feat_path.exists():
        try:
            from backend.app.services.model_registry import resolve_feature_spec_path
            feat_path = resolve_feature_spec_path(req.prop_type)
        except Exception:
            feat_path = None

    if not feat_path or not feat_path.exists():
        listing = sorted(p.name for p in md.glob("*"))
        raise HTTPException(
            500,
            f"Features file not found alongside model for '{req.prop_type}' in {md}; saw: {listing}"
        )

    # Load model(s)
    pipe = joblib.load(model_path)
    zero_pipe = joblib.load(zero_path) if zero_path else None

    # Align strictly numeric features to spec
    spec = _load_feature_spec(feat_path)
    X = _align_numeric_row(req.features, spec)

    # Predict lambda (and optional zero prob)
    try:
        lam = float(np.clip(pipe.predict(X)[0], 1e-9, 1e9))
    except Exception as e:
        raise HTTPException(500, f"predict failed: {e} | n_spec={len(spec)} | model={model_path.name}")

    if zero_pipe is not None:
        try:
            pi = float(zero_pipe.predict_proba(X)[0, 1])
        except Exception:
            pi = 0.0
    else:
        pi = 0.0

    if req.line is None:
        raise HTTPException(400, "line is required for scoring")

    p_over_raw = _zip_tail_over(req.line, pi, lam)
    p_over = _apply_calibrator_scalar(p_over_raw, cal_path, req.line) if (cal_path and cal_path.exists()) else p_over_raw

    # Canonical identifiers from features (server trusts prepareProp)
    f = req.features
    try:
        player_id = int(f["player_id"])
        game_id   = int(f["game_id"])
        game_date = f.get("game_date")
        team_id   = f.get("team_id")
        team_abbr = (f.get("team") or "").upper() or None
        if team_id is not None:
            team_id = int(team_id)
    except Exception as e:
        raise HTTPException(400, f"Missing/invalid identifiers in features: {e}")

    # Build a deterministic hash of the numeric vector the model saw
    # Reuse the row dict we constructed in _align_numeric_row
    numeric_row = {k: float(f.get(k, 0.0)) for k in spec}
    fhash = features_hash(spec, numeric_row)

    # Token claims: include everything needed to store the prop exactly as scored
    import time
    now = int(time.time())
    claims = {
        "v": 1,
        "iat": now,
        "exp": now + 30 * 60,  # 30 minutes
        "prop_type": req.prop_type,
        "line": float(req.line),
        "player_id": player_id,
        "game_id": game_id,
        "game_date": game_date,
        "team_id": team_id,
        "team_abbr": team_abbr,
        "model_version": version,
        "mu": lam,
        "p_over": p_over,
        "features_hash": fhash,
        # optional for auditing:
        "artifact": model_path.name,
        "feat_file": feat_path.name,
    }
    commit_token = mint_commit_token(claims)

    return {
        "prop_type": req.prop_type,
        "line": req.line,
        "mu": lam,
        "p_over": p_over,
        "p_under": 1.0 - p_over,
        "p_over_raw": p_over_raw,
        "used_zero_model": bool(zero_path),
        "used_model": True,
        "model_version": version,
        "artifact_dir": str(md),
        "model_file": model_path.name,
        "zero_model_file": zero_path.name if zero_path else None,
        "calibrators_file": cal_path.name if cal_path else None,
        "features_file": feat_path.name,
        "commit_token": commit_token,
    }
