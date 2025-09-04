# backend/app/routes/api/score_prop.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, List, Tuple, Optional
from pathlib import Path
import os, json, math

import numpy as np
import pandas as pd
import joblib
from sqlalchemy import create_engine, text
from scipy.stats import poisson

# Reuse your enrichment (adds game_time, day_of_week, etc.; safe if unused by model)
from backend.scripts.shared.enrich_game_context import enrich_game_context

router = APIRouter()

# ---------- Config / paths ----------
def _models_root() -> Path:
    # Keep using props/latest layout (you already symlink latest -> vYYYYMMDD)
    base = os.getenv("MODEL_DIR") or "/var/data/models/props"
    return Path(base).resolve() / "latest"

def _model_dir(prop: str) -> Path:
    return _models_root() / prop

# ---------- DB engine ----------
_engine = None
def _get_engine():
    """
    Uses DATABASE_URL. For Supabase pooler the correct form is:
    postgresql+psycopg://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require
    """
    global _engine
    if _engine is None:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL not set")
        _engine = create_engine(url, pool_pre_ping=True)
    return _engine

# ---------- Model + feature discovery ----------
def _find_model_file(md: Path) -> Path:
    # Prefer "*poisson*.joblib" (e.g., tb_poisson_v1.joblib)
    cand = sorted(md.glob("*poisson*.joblib"))
    if not cand:
        # fallback: any .joblib
        cand = sorted(md.glob("*.joblib"))
    if not cand:
        raise FileNotFoundError(f"No .joblib model under {md}")
    return cand[0]

def _find_features_file(md: Path) -> Path:
    # Prefer "*features*.json" local to the prop dir
    cand = sorted(md.glob("*features*.json"))
    if cand:
        return cand[0]

    # Fallback: read MODEL_INDEX.json at props/latest
    idx = _models_root() / "MODEL_INDEX.json"
    if idx.exists():
        try:
            bag = json.loads(idx.read_text())
            props = bag.get("props", {})
            if isinstance(props, dict) and props:
                name = md.name
                meta = props.get(name, {})
                rel = meta.get("features_file")
                if rel:
                    ff = _models_root() / rel
                    if ff.exists():
                        return ff
        except Exception:
            pass

    raise FileNotFoundError(f"No features file found in {md} or MODEL_INDEX.json")

def _load_feature_names(features_path: Path) -> List[str]:
    data = json.loads(features_path.read_text())
    # Accept either {"features":[...]} or a raw array
    if isinstance(data, dict) and "features" in data and isinstance(data["features"], list):
        return [str(x) for x in data["features"]]
    if isinstance(data, list):
        return [str(x) for x in data]
    raise ValueError(f"Invalid features JSON structure in {features_path}")

# ---------- Team/opponent resolver (ID-first, abbr only for features) ----------
def _resolve_team_and_opponent(conn, player_id: int, game_id: int) -> Tuple[int, str, str]:
    """
    Returns (team_id, team_abbr, opp_abbr) for (player_id, game_id).
    • team_id from player_team_by_game (authoritative)
    • team/opponent from player_stats for that game (string abbrs for model features)
    Falls back to model_training_props.team_id if needed.
    """
    row = conn.execute(
        text("""
        WITH base AS (
          SELECT :pid::bigint AS player_id, :gid::bigint AS game_id
        )
        SELECT
          COALESCE(ptbg.team_id, mtp.team_id) AS team_id,
          ps.team,
          ps.opponent
        FROM base b
        LEFT JOIN public.player_stats ps
          ON ps.player_id = b.player_id AND ps.game_id = b.game_id
        LEFT JOIN public.player_team_by_game ptbg
          ON ptbg.player_id = b.player_id AND ptbg.game_id = b.game_id
          AND ptbg.team_id IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT m.team_id
          FROM public.model_training_props m
          WHERE m.player_id = b.player_id
            AND m.game_id   = b.game_id
            AND m.team_id IS NOT NULL
          ORDER BY m.created_at DESC
          LIMIT 1
        ) mtp ON TRUE
        LIMIT 1;
        """),
        {"pid": player_id, "gid": game_id},
    ).mappings().first()

    if not row or row["team_id"] is None:
        raise HTTPException(404, "Could not determine teamId for player/game")

    team = (row["team"] or "").strip().upper()
    opp  = (row["opponent"] or "").strip().upper()
    if not team or not opp:
        # team/opponent strings are only for model features, but the model expects them present
        raise HTTPException(404, "Missing team/opponent abbreviations in player_stats for that game")

    return int(row["team_id"]), team, opp

# ---------- Request model ----------
class ScoreReq(BaseModel):
    prop_type: str
    player_id: int
    game_date: str   # YYYY-MM-DD
    line: float

# ---------- Utility: build single-row X with EXACT feature columns ----------
_NUMERIC_LIKE_PREFIXES = ("d7_", "d15_", "d30_", "bvp_", "d15", "d30")
def _is_string_feature(name: str) -> bool:
    # In your TB model the only string columns are 'team' and 'opponent'
    return name in ("team", "opponent")

def _build_feature_row(required: List[str],
                       team: str, opp: str) -> Dict[str, Any]:
    row: Dict[str, Any] = {}
    for col in required:
        if _is_string_feature(col):
            row[col] = team if col == "team" else opp
        else:
            # default numeric 0.0 for missing rolling/BvP stats
            row[col] = 0.0
    return row

# ---------- Calibrator ----------
def _apply_calibrator(p: float, cal_path: Path) -> float:
    try:
        bag = json.loads(cal_path.read_text())
        entry = next(iter(bag.values())) if isinstance(bag, dict) else (bag[0] if bag else None)
        if not entry or entry.get("type") != "isotonic":
            return p
        x = np.array(entry["x"], dtype=float)
        y = np.array(entry["y"], dtype=float)
        return float(np.interp(p, x, y))
    except Exception:
        return p

# ---------- Route ----------
@router.post("/api/score-prop")
def score_prop(req: ScoreReq):
    md = _model_dir(req.prop_type)
    if not md.exists():
        raise HTTPException(500, f"Model dir not found: {md}")

    model_path = _find_model_file(md)
    pipe = joblib.load(model_path)

    features_path = _find_features_file(md)
    required_cols = _load_feature_names(features_path)
    if not required_cols:
        raise HTTPException(500, f"No features listed in {features_path}")

    # Resolve game_id for (player_id, game_date)
    engine = _get_engine()
    with engine.begin() as conn:
        gid = conn.execute(
            text("""
                SELECT game_id
                FROM public.player_stats
                WHERE player_id = :pid AND game_date = :gdt
                LIMIT 1
            """),
            {"pid": req.player_id, "gdt": req.game_date},
        ).scalar()

        if not gid:
            raise HTTPException(404, f"No game found for playerId={req.player_id} on {req.game_date}")

        team_id, team_abbr, opp_abbr = _resolve_team_and_opponent(conn, req.player_id, int(gid))

    # Build single-row with EXACT required columns (avoid passthrough of extra string cols)
    row = _build_feature_row(required_cols, team_abbr, opp_abbr)
    X = pd.DataFrame([row], columns=required_cols)

    # Ensure dtypes (strings for team/opponent, float for others)
    for c in required_cols:
        if _is_string_feature(c):
            X[c] = X[c].astype("string")
        else:
            X[c] = pd.to_numeric(X[c], errors="coerce").fillna(0.0).astype("float64")

    # Predict expected count and map to tail prob
    try:
        mu = float(pipe.predict(X)[0])
    except Exception as e:
        # Helpful debug when schema drifts
        missing = set(required_cols) - set(X.columns)
        extras  = set(X.columns) - set(required_cols)
        raise HTTPException(
            500,
            f"predict failed: {e} | missing={sorted(missing)} extras={sorted(extras)} model={model_path}"
        )

    k = math.floor(req.line)
    p_over_raw = 1.0 - poisson.cdf(k, mu)

    # Optional calibrator in the same dir (e.g., tb_calibrators_v1.json or *calibrators*.json)
    cal_path = next(iter(md.glob("*calibrators*.json")), None)
    p_over = _apply_calibrator(p_over_raw, cal_path) if cal_path else p_over_raw

    return {
        "prop_type": req.prop_type,
        "player_id": req.player_id,
        "game_date": req.game_date,
        "line": req.line,
        "mu": mu,
        "p_over": p_over,
        "p_under": 1.0 - p_over,
        "p_over_raw": p_over_raw,
        "used_model": True,
        "process": "poisson",
        "model_version": md.parent.name,  # vYYYYMMDD via symlink
    }
