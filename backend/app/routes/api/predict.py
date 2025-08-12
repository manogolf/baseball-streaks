# backend/app/routes/api/predict.py
from __future__ import annotations

import json
import os
import sys
import time
import subprocess
from typing import Any, Dict
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, AliasChoices
from pydantic.config import ConfigDict
from app.security.commit_token import mint_commit_token

router = APIRouter()

# Choose backend: set PREDICT_MODE=subprocess to force subprocess
FORCE_SUBPROC = os.getenv("PREDICT_MODE", "").lower() == "subprocess"

# Try to import your real predictor module (preferred path)
_predict_mod = None
try:
    # expects: backend/scripts/prediction/make_prediction.py
    from backend.scripts.prediction import make_prediction as _predict_mod  # type: ignore
except Exception:
    _predict_mod = None

# Optional canonicalizers
_canon_func = None
try:
    from app.prop_utils import get_canonical_model_name as _canon_func  # returns canonical or None
except Exception:
    try:
        from app.services.model_registry import canonicalize_prop_type as _canon_func  # raises on bad input
    except Exception:
        _canon_func = None


class PredictInput(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    prop_type: str = Field(validation_alias=AliasChoices("prop_type", "propType"))
    features: Dict[str, Any] = Field(default_factory=dict)


def _canonicalize_prop(name: str) -> str:
    if _canon_func is None:
        return str(name)
    try:
        out = _canon_func(name)
        return out if out else str(name)
    except Exception:
        return str(name)


def _call_predict_module(prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    """
    Call in-process predictor. Supports either predict() or make_prediction().
    Must return a dict with a probability field.
    """
    if _predict_mod is None:
        raise RuntimeError("predict module not importable")
    if hasattr(_predict_mod, "predict"):
        return _predict_mod.predict(prop_type=prop_type, features=features)  # type: ignore[attr-defined]
    if hasattr(_predict_mod, "make_prediction"):
        return _predict_mod.make_prediction(prop_type=prop_type, features=features)  # type: ignore[attr-defined]
    raise RuntimeError("No callable predict()/make_prediction() in module")


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

    # Build a features copy for the model: DO NOT include over_under (direction)
    features_for_model = dict(features)
    features_for_model.pop("over_under", None)

    # Call predictor (module or subprocess)
    used_model, backend = False, None
    t0 = time.time()
    try:
        if not FORCE_SUBPROC and _predict_mod is not None:
            out = _call_predict_module(canonical, features_for_model)
            used_model, backend = True, "module"
        else:
            out = _call_predict_subprocess(canonical, features_for_model)
            used_model, backend = True, "subprocess"
    except HTTPException:
        raise
    except Exception as e:
        # Fallback stub so UI flow can continue (should be rare)
        out = {"prob": 0.5, "stub": True}
        used_model, backend = False, None
    dt_ms = int((time.time() - t0) * 1000)

    # Prefer explicit P(over) from model; otherwise normalize common fields.
    try:
        if "probability_over" in out:
            p_over = float(out["probability_over"])
        else:
            p_over = float(_normalize_prob(out))
        p_over = max(0.0, min(1.0, p_over))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"predictor did not return prob: {e}")

    # Pick direction based on user input; be direction-agnostic in the model.
    direction = (features.get("over_under") or "over").lower()
    prob = p_over if direction == "over" else (1.0 - p_over)

    model_tag = out.get("model") or out.get("model_name") or out.get("algo")

    meta = {
        "used_model": used_model,
        "backend": backend,
        "model": model_tag,
        "stub": not used_model or bool(out.get("stub")),
        "features_count": len(features),
        "elapsed_ms": dt_ms,
        "direction": direction,
        "p_over": p_over,
        "p_under": 1.0 - p_over,
    }

    # Mint commit token AFTER computing the final prob
    token = mint_commit_token(
        prob=prob,
        prop_type=canonical,
        features={k: v for k, v in features.items() if k is not None},
        ttl_seconds=int(os.getenv("PROP_COMMIT_TTL_SEC", "600")),
        secret=os.getenv("PROP_COMMIT_SECRET", "dev-secret-change-me"),
        version="v1",
    )

    # Pass through any extra fields, but avoid duplicating prob fields
    passthrough = {
        k: v
        for k, v in out.items()
        if k not in {"prob", "probability", "probability_over", "confidence"}
    }
    # Ensure both directions present for UI/debug
    passthrough.setdefault("probability_over", p_over)
    passthrough.setdefault("probability_under", 1.0 - p_over)
    passthrough["prop_type"] = canonical

    return {
        "prob": prob,
        "commit_token": token,
        "meta": meta,
        **passthrough,
    }
