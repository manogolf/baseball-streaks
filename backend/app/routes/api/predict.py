# backend/app/routes/api/predict.py
from __future__ import annotations

import json
import os
import sys
import time
import subprocess
from typing import Any, Dict
from pathlib import Path
from backend.scripts.shared.supabase_utils import supabase
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, AliasChoices
from pydantic.config import ConfigDict

from backend.app.security.commit_token import mint_commit_token
from backend.app.services.model_registry import (
    canonicalize_prop_type as _canon_func,
    get_expected_features as _expected_features,
)

ENRICH_TABLE_OVERRIDES: Dict[str, str] = {}  # <-- top-level, no indent
router = APIRouter()

# Choose backend: set PREDICT_MODE=subprocess to force subprocess
FORCE_SUBPROC = os.getenv("PREDICT_MODE", "").lower() == "subprocess"

# Prefer in-process module; fall back to subprocess when forced/unavailable
try:
    from backend.scripts.prediction.make_prediction import predict as _predict
except Exception:
    _predict = None  # subprocess path will be used


def _extract_prob(d: Any) -> float:
    """Return a 0–1 probability from the predictor; raise if missing/invalid."""
    if not isinstance(d, dict):
        raise ValueError("predictor returned a non-dict payload")

    # common keys we accept, in priority order
    for key in ("probability", "probability_over", "prob", "confidence"):
        if key in d and d[key] is not None:
            try:
                p = float(d[key])
                return max(0.0, min(1.0, p))
            except (TypeError, ValueError):
                raise ValueError(f"invalid probability at '{key}': {d[key]!r}")

    raise ValueError("predictor did not provide a probability field")


class PredictInput(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    prop_type: str = Field(validation_alias=AliasChoices("prop_type", "propType"))
    features: Dict[str, Any] = Field(default_factory=dict)

def _enrich_features_from_training_view(prop_type: str, feats: Dict[str, Any]) -> Dict[str, Any]:
    """
    Fill missing engineered features for the given prop from the training view.
    Default table name: training_features_{prop_type}_enriched.
    Keys already present in feats are NOT overwritten.
    """
    prop = (_canon_func(prop_type) if _canon_func else prop_type).lower()
    table = ENRICH_TABLE_OVERRIDES.get(prop, f"training_features_{prop}_enriched")
    pid = feats.get("player_id")
    gdate = feats.get("game_date")
    if not pid or not gdate:
        return feats
    try:
        resp = (
            supabase.table(table)
            .select("*")
            .eq("player_id", pid)
            .eq("game_date", gdate)     # 'YYYY-MM-DD'
            .limit(1)
            .execute()
        )
        rows = getattr(resp, "data", None) or []
        if rows:
            row = rows[0]
            for k, v in row.items():
                feats.setdefault(k, v)  # fill only missing keys
    except Exception as e:
        print(f"[predict] enrich fetch failed table={table}: {e}", flush=True)
    return feats

def _canonicalize_prop(name: str) -> str:
    if _canon_func is None:
        return str(name)
    try:
        out = _canon_func(name)
        return out if out else str(name)
    except Exception:
        return str(name)


def _call_predict_module(prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    if _predict is None:
        raise RuntimeError("predict function not importable")
    return _predict(prop_type=prop_type, features=features)


def _call_predict_subprocess(prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    payload = json.dumps({"prop_type": prop_type, "features": features})

    PROJECT_ROOT = Path(__file__).resolve().parents[4]   # /opt/render/project/src
    BACKEND_DIR  = PROJECT_ROOT / "backend"              # /opt/render/project/src/backend

    cmd = [sys.executable, "-m", "backend.scripts.prediction.make_prediction"]

    env = os.environ.copy()
    pieces = [str(PROJECT_ROOT), str(BACKEND_DIR)]
    if env.get("PYTHONPATH"):
        pieces.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = ":".join(pieces)

    try:
        proc = subprocess.run(
            cmd,
            input=payload.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            timeout=60,
            env=env,
            cwd=str(PROJECT_ROOT),  # keep imports consistent
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(
            status_code=500,
            detail=f"predict subprocess failed: {e.stderr.decode('utf-8','ignore')[:4000]}",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"predict subprocess error: {e}")

    try:
        return json.loads(proc.stdout.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"invalid JSON from predictor: {e}")


@router.post("/predict")
async def predict(req: Request):
    # Parse + validate request
    try:
        payload = await req.json()
    except Exception:
        raw = (await req.body()).decode("utf-8", "ignore")
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {raw[:300]}")

    try:
        inp = PredictInput.model_validate(payload)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid request: {e}")

    features: Dict[str, Any] = inp.features or {}
    if not isinstance(features, dict):
        raise HTTPException(status_code=400, detail="features must be an object")

    canonical = _canonicalize_prop(inp.prop_type)

    # For the model call, strip direction (model is direction-agnostic)
    features_for_model = dict(features)
    features_for_model.pop("over_under", None)
    
    # Uniform enrichment for ALL prop types before calling the model
    features_for_model = _enrich_features_from_training_view(canonical, features_for_model)

    # Call predictor (module or subprocess)
    used_model, backend = False, None
    t0 = time.time()
    try:
        if not FORCE_SUBPROC and _predict is not None:
            out = _call_predict_module(canonical, features_for_model)
            used_model, backend = True, "module"
        else:
            out = _call_predict_subprocess(canonical, features_for_model)
            used_model, backend = True, "subprocess"
    except HTTPException:
        raise
    except Exception as e:
        # Bubble the error so we SEE it, instead of silently returning 0.5
        raise HTTPException(status_code=500, detail=f"prediction failed upstream: {e}")
    dt_ms = int((time.time() - t0) * 1000)

    # Normalize whatever we got back into a single probability
    p_over = _extract_prob(out)

    # Clamp (just in case)
    p_over = max(0.0, min(1.0, p_over))

    # Direction from user input; model returns P(over)
    direction = (features.get("over_under") or "over").lower()

    # Always expose the model's raw probabilities
    p_under = 1.0 - p_over
    recommended = "over" if p_over >= 0.5 else "under"
    confidence = max(p_over, p_under)  # 0.5..1.0

    # Convenience: probability of the *user's chosen side*
    # (safe for UI, but does NOT affect the model's recommendation)
    prob_user = p_over if direction == "over" else p_under

    model_tag = out.get("model") or out.get("model_name") or out.get("algo")

    # Small debug/meta block to validate feature wiring
    try:
        expected = _expected_features(canonical, prefer="random_forest")
        expected_count = len(expected or [])
    except Exception:
        expected_count = None

    meta = {
        "used_model": used_model,
        "backend": backend,
        "model": model_tag,
        "stub": not used_model or bool(out.get("stub")),
        "features_count": len(features),
        "expected_feature_count": expected_count,
        "elapsed_ms": dt_ms,
        "direction": direction,   # what the user picked
        "p_over": p_over,         # raw model prob
        "p_under": p_under,       # raw model prob
        "recommended": recommended,
        "confidence": confidence,
    }

    # Mint commit token using the probability of the chosen side
    token = mint_commit_token(
        prob=prob_user,
        prop_type=canonical,
        features={k: v for k, v in features.items() if k is not None},
        ttl_seconds=int(os.getenv("PROP_COMMIT_TTL_SEC", "600")),
        secret=os.getenv("PROP_COMMIT_SECRET", "dev-secret-change-me"),
        version="v1",
    )

    # Pass through any extra fields from the predictor, but avoid duplicates
    passthrough = {
        k: v
        for k, v in out.items()
        if k not in {
            "prob", "probability", "probability_over", "probability_under",
            "confidence", "recommended", "model"
        }
    }
    passthrough["prop_type"] = canonical

    return {
        # UI convenience (probability of the user's chosen side)
        "prob": prob_user,

        # Canonical, always-present model outputs
        "p_over": p_over,
        "p_under": p_under,
        "recommended": recommended,
        "confidence": confidence,

        "commit_token": token,
        "meta": meta,
        **passthrough,
    }
