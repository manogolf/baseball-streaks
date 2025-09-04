# backend/app/routes/api/score_prop.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from pathlib import Path
import os, json, math
import joblib
import numpy as np
import pandas as pd
from scipy.stats import poisson
from sqlalchemy import create_engine, text

router = APIRouter()

# ---- DB engine (lazy singleton) ----
_ENGINE = None
def get_engine():
    global _ENGINE
    if _ENGINE is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL not set")
        _ENGINE = create_engine(url, pool_pre_ping=True)
    return _ENGINE

class ScoreReq(BaseModel):
    prop_type: str
    player_id: int
    game_date: str
    line: float
    game_id: int | None = None  # optional shortcut

def _model_dir(prop: str) -> Path:
    return (Path(os.getenv("MODEL_DIR", "/var/data/models/props")) / "latest" / prop).resolve()

def _pick_joblib(md: Path) -> Path | None:
    for pat in ("*poisson*.joblib", "*.joblib"):
        m = next(iter(md.glob(pat)), None)
        if m:
            return m
    return None

def _feature_list(md: Path, prop: str) -> list[str]:
    # prefer tb_features_v1.json (object with {"features":[...]})
    cands = [
        md / f"{prop[:2]}_features_v1.json",
        md / f"features_{prop}_v1.json",
        md / "features.json",
    ]
    for p in cands:
        if p.exists():
            try:
                data = json.loads(p.read_text())
                if isinstance(data, dict) and "features" in data:
                    return [str(x) for x in data["features"]]
                if isinstance(data, list):
                    return [str(x) for x in data]
            except Exception:
                pass
    raise HTTPException(500, f"features list JSON not found or unreadable under {md}")

def _resolve_gid(conn, pid: int, gdt: str) -> int:
    gid = conn.execute(
        text("""select game_id
                from public.player_stats
                where player_id = :pid and game_date = :gdt
                limit 1"""),
        {"pid": pid, "gdt": gdt},
    ).scalar()
    if not gid:
        raise HTTPException(404, f"No game_id for player_id={pid} on {gdt}")
    return int(gid)

def _fetch_feature_row(conn, prop: str, pid: int, gid: int, needed: list[str]) -> pd.DataFrame:
    view = f"export_train_batter_{prop}"  # e.g. export_train_batter_total_bases
    row = conn.execute(
        text(f"select * from public.{view} where player_id = :pid and game_id = :gid limit 1"),
        {"pid": pid, "gid": gid},
    ).mappings().first()
    if not row:
        raise HTTPException(404, f"No feature row in {view} for player_id={pid}, game_id={gid}")

    sample = {k: row.get(k) for k in needed}
    # fill Nones with 0, and ensure strings exist for team/opponent
    for k in list(sample.keys()):
        if sample[k] is None:
            sample[k] = 0
    for k in ("team", "opponent"):
        if k in sample and (sample[k] is None or str(sample[k]).strip() == ""):
            sample[k] = "UNK"

    return pd.DataFrame([sample], columns=needed)

def _apply_calibrator(p: float, cal_path: Path) -> float:
    try:
        data = json.loads(cal_path.read_text())
        entry = next(iter(data.values())) if isinstance(data, dict) else data[0]
        if isinstance(entry, dict) and entry.get("type") == "isotonic":
            x = np.array(entry["x"], float); y = np.array(entry["y"], float)
            return float(np.interp(p, x, y))
    except Exception:
        pass
    return p

@router.post("/api/score-prop")
def score_prop(req: ScoreReq):
    md = _model_dir(req.prop_type)
    lam = _pick_joblib(md)
    if not lam or not Path(lam).exists():
        raise HTTPException(500, f"No model joblib found under {md}")

    features = _feature_list(md, req.prop_type)
    pipe = joblib.load(lam)

    engine = get_engine()
    with engine.connect() as conn:
        gid = req.game_id or _resolve_gid(conn, req.player_id, req.game_date)
        X = _fetch_feature_row(conn, req.prop_type, req.player_id, gid, features)

    mu = float(pipe.predict(X)[0])
    k = math.floor(req.line)
    p_over_raw = 1.0 - poisson.cdf(k, mu)

    cal = md / f"{req.prop_type[:2]}_calibrators_v1.json"
    p_over = _apply_calibrator(p_over_raw, cal) if cal.exists() else p_over_raw

    return {
        "prop_type": req.prop_type,
        "line": req.line,
        "mu": mu,
        "p_over": p_over,
        "p_under": 1.0 - p_over,
        "p_over_raw": p_over_raw,
        "used_model": True,
        "model_version": md.parent.name,
        "process": "poisson",
        "game_id": int(gid),
    }
