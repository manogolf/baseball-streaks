#  backend/app/routes/api/score_prop.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import os, json, math
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from scipy.stats import poisson

router = APIRouter()

class ScoreReq(BaseModel):
    prop_type: str
    player_id: int
    game_date: str   # "YYYY-MM-DD"
    line: float

def _model_dir(prop: str) -> Path:
    base = Path(os.getenv("MODEL_DIR", "/var/data/models/props")) / "latest" / prop
    return base

def _apply_calibrator(p: float, cal_path: Path) -> float:
    try:
        bag = json.loads(cal_path.read_text())
        # pick the first mapping
        entry = next(iter(bag.values())) if isinstance(bag, dict) else bag[0]
        if entry.get("type") != "isotonic":  # identity or unknown → return p
            return p
        x = np.array(entry["x"], dtype=float)
        y = np.array(entry["y"], dtype=float)
        return float(np.interp(p, x, y))
    except Exception:
        return p

@router.post("/api/score-prop")
def score_prop(req: ScoreReq):
    md = _model_dir(req.prop_type)

    # 1) locate poisson model
    lam_file = md / f"{req.prop_type[:2]}_poisson_v1.joblib"  # e.g. tb_poisson_v1.joblib
    if not lam_file.exists():
        lam_file = next(iter(md.glob("*poisson*.joblib")), None)
    if not lam_file or not Path(lam_file).exists():
        raise HTTPException(500, f"Poisson model not found for '{req.prop_type}' in {md}")

    pipe = joblib.load(lam_file)

    # 2) load required feature columns
    feat_file = None
    for cand in [md / f"{req.prop_type[:2]}_features_v1.json", *md.glob("*features*.json")]:
        if cand.exists():
            feat_file = cand
            break
    if not feat_file:
        raise HTTPException(500, f"Features file not found in {md}")

    try:
        spec = json.loads(feat_file.read_text())
    except Exception as e:
        raise HTTPException(500, f"Invalid features file {feat_file}: {e}")

    req_cols = spec["features"] if isinstance(spec, dict) and "features" in spec else spec
    if not isinstance(req_cols, list):
        raise HTTPException(500, f"Features file {feat_file} must be a list or {{'features':[...]}}, got {type(req_cols).__name__}")

    # 3) build single-row with every expected column present
    row = {}
    for col in req_cols:
        if col in ("team", "opponent"):
            row[col] = "UNK"        # safe default; OneHotEncoder should ignore unknown if configured
        else:
            row[col] = 0.0          # numeric defaults

    X = pd.DataFrame([row], columns=req_cols)

    # 4) predict and calibrate
    mu = float(pipe.predict(X)[0])  # expected count
    k = math.floor(req.line)
    p_over_raw = 1.0 - poisson.cdf(k, mu)
    p_over = p_over_raw

    cal_path = md / f"{req.prop_type[:2]}_calibrators_v1.json"
    if cal_path.exists():
        p_over = _apply_calibrator(p_over_raw, cal_path)

    return {
        "prop_type": req.prop_type,
        "line": req.line,
        "mu": mu,
        "p_over": p_over,
        "p_under": 1.0 - p_over,
        "p_over_raw": p_over_raw,
        "used_model": True,
        "model_version": str(Path(md).parent.name),  # vYYYYMMDD
        "process": "poisson",
    }
