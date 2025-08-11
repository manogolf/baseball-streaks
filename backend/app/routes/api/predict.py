# backend/app/routes/api/predict.py
from __future__ import annotations

import json
import os
import sys
import time
import subprocess
from typing import Any, Dict
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, AliasChoices
from pydantic.config import ConfigDict

from app.security.commit_token import mint_commit_token
from app.prop_utils import get_canonical_model_name

router = APIRouter()

# Try to import your real predictor module (preferred)
_predict_mod = None
try:
    # expects: backend/scripts/prediction/make_prediction.py
    from backend.scripts.prediction import make_prediction as _predict_mod  # type: ignore
except Exception:
    _predict_mod = None


class PredictInput(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    # accept both "prop_type" and "propType"
    prop_type: str = Field(validation_alias=AliasChoices("prop_type", "propType"))
    features: Dict[str, Any] = Field(default_factory=dict)


def _call_predict_module(prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    """
    Call in-process predictor. Supports either predict() or make_prediction().
    Must return {"prob": float in [0,1], ...}.
    """
    if _predict_mod is None:
        raise RuntimeError("predict module not importable")
    if hasattr(_predict_mod, "predict"):
        return _predict_mod.predict(prop_type=prop_type, features=features)  # type: ignore[attr-defined]
    if hasattr(_predict_mod, "make_prediction"):
        return _predict_mod.make_prediction(prop_type=prop_type, features=features)  # type: ignore[attr-defined]
    raise RuntimeError("No callable predict()/make_prediction() in module")


def _call_predict_subprocess(prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    """
    Fallback: run the predictor as a subprocess that reads JSON on stdin
    and writes JSON to stdout.
    """
    payload = json.dumps({"prop_type": prop_type, "features": features})
    cmd = [sys.executable, "-m", "backend.scripts.prediction.make_prediction"]
    try:
        proc = subprocess.run(
            cmd,
            input=payload.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            timeout=60,
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(
            status_code=500,
            detail=f"predict subprocess failed: {e.stderr.decode('utf-8', 'ignore')[:4000]}",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"predict subprocess error: {e}")

    try:
        return json.loads(proc.stdout.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"invalid JSON from predictor: {e}")


def _normalize_prob(obj: Dict[str, Any]) -> float:
    """Accept 'prob', 'probability', or 'confidence' (0..1 or 0..100)."""
    for k in ("prob", "probability", "confidence"):
        if k in obj:
            v = float(obj[k])
            if v > 1.0:
                v /= 100.0
            return max(0.0, min(1.0, v))
    raise ValueError("Predictor returned no probability field")


@router.post("/predict")
async def predict(req: Request):
    # 1) Parse + validate input
    try:
        payload = await req.json()
    except Exception:
        raw = (await req.body()).decode("utf-8", "ignore")
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {raw[:300]}")

    try:
        inp = PredictInput.model_validate(payload)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}")

    features: Dict[str, Any] = dict(inp.features or {})
    prop_type: str = (inp.prop_type or "").strip()

    if not prop_type:
        raise HTTPException(status_code=400, detail="prop_type required")
    if not features:
        raise HTTPException(status_code=400, detail="features required")

    # 2) Canonicalize model key; add internal alias 'line' if needed
    canonical = get_canonical_model_name(prop_type) or prop_type
    if "line" not in features and "prop_value" in features:
        try:
            features["line"] = float(features["prop_value"])
        except Exception:
            pass

    # 3) Run predictor
    used_model = False
    backend = None
    model_tag = None
    t0 = time.time()

    try:
        if _predict_mod is not None:
            out = _call_predict_module(canonical, features)
            backend = "module"
        else:
            out = _call_predict_subprocess(canonical, features)
            backend = "subprocess"
        used_model = True
    except HTTPException:
        raise
    except Exception as e:
        print(f"⚠️ predict fallback: {e}")
        out = {"prob": 0.5, "stub": True}

    # 4) Normalize output + mint commit token
    try:
        prob = _normalize_prob(out)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"predictor did not return prob: {e}")

    model_tag = out.get("model") or out.get("model_name") or out.get("algo")
    dt_ms = int((time.time() - t0) * 1000)

    print(
        f"🔮 predict used_model={used_model} backend={backend} prop={canonical} "
        f"prob={prob:.4f} nfeat={len(features)} took={dt_ms}ms model={model_tag}"
    )

    token = mint_commit_token(
        prob=prob,
        prop_type=canonical,
        features={k: v for k, v in features.items() if k is not None},
        ttl_seconds=int(os.getenv("PROP_COMMIT_TTL_SEC", "600")),
        secret=os.getenv("PROP_COMMIT_SECRET", "dev-secret-change-me"),
        version="v1",
    )

    meta = {
        "used_model": used_model,
        "backend": backend,
        "model": model_tag,
        "stub": bool(out.get("stub")),
        "features_count": len(features),
        "elapsed_ms": dt_ms,
    }

    passthrough = {k: v for k, v in out.items() if k not in {"prob", "probability", "confidence"}}

    return {"prob": prob, "commit_token": token, "meta": meta, **passthrough}
