# backend/app/routes/api/predict.py
from __future__ import annotations

import json, os, sys, time, subprocess
from typing import Any, Dict
from pydantic import BaseModel, Field, AliasChoices
from pydantic.config import ConfigDict
from fastapi import APIRouter, HTTPException, Request

from app.security.commit_token import mint_commit_token
from app.prop_utils import get_canonical_model_name

router = APIRouter()

# env toggle: "subprocess" forces short-lived runner
FORCE_SUBPROC = os.getenv("PREDICT_MODE", "").strip().lower() == "subprocess"

# Try to import your real predictor module (preferred when not forcing subprocess)
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
    Must return {"prob": float in [0,1]} or a dict containing probability.
    """
    if _predict_mod is None:
        raise RuntimeError("predict module not importable")

    # Handle both signatures:
    #   predict(prop_type=..., features=...)
    #   make_prediction({"prop_type":..., "features":{...}})
    if hasattr(_predict_mod, "predict"):
        return _predict_mod.predict(prop_type=prop_type, features=features)  # type: ignore[attr-defined]
    if hasattr(_predict_mod, "make_prediction"):
        # Some versions expect a single payload dict
        try:
            return _predict_mod.make_prediction({"prop_type": prop_type, "features": features})  # type: ignore[attr-defined]
        except TypeError:
            # Others accept keyword args
            return _predict_mod.make_prediction(prop_type=prop_type, features=features)  # type: ignore[attr-defined]
    raise RuntimeError("No callable predict()/make_prediction() in module")


from pathlib import Path

def _call_predict_subprocess(prop_type: str, features: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run short-lived predictor with a robust path setup:
      1) try:  python -m backend.scripts.prediction.make_prediction
      2) else: python /abs/path/to/backend/scripts/prediction/make_prediction.py
    We set CWD and PYTHONPATH so 'backend' and 'app' are importable.
    """
    payload = json.dumps({"prop_type": prop_type, "features": features}).encode("utf-8")

    # Resolve paths
    this = Path(__file__).resolve()                                   # .../backend/app/routes/api/predict.py
    backend_dir = this.parents[3]                                      # .../backend
    project_root = backend_dir.parent                                  # repo root
    script_path = backend_dir / "scripts" / "prediction" / "make_prediction.py"

    # Env with PYTHONPATH so 'backend' (and 'app') are importable
    env = os.environ.copy()
    py_path_bits = [str(project_root), str(backend_dir)]
    if env.get("PYTHONPATH"):
        py_path_bits.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = ":".join(py_path_bits)

    # 1) Try module form
    cmd_mod = [sys.executable, "-m", "backend.scripts.prediction.make_prediction"]
    try:
        proc = subprocess.run(
            cmd_mod, input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True, timeout=60, cwd=str(project_root), env=env
        )
        return json.loads(proc.stdout.decode("utf-8"))
    except subprocess.CalledProcessError as e:
        err = e.stderr.decode("utf-8", "ignore")
        # fall through to path form
    except Exception as e:
        err = str(e)

    # 2) Try direct file path
    if not script_path.exists():
        raise HTTPException(status_code=500, detail=f"predict subprocess cannot find script at {script_path}")

    cmd_file = [sys.executable, str(script_path)]
    try:
        proc = subprocess.run(
            cmd_file, input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True, timeout=60, cwd=str(project_root), env=env
        )
        return json.loads(proc.stdout.decode("utf-8"))
    except subprocess.CalledProcessError as e:
        raise HTTPException(
            status_code=500,
            detail=f"predict subprocess failed: {e.stderr.decode('utf-8','ignore')[:4000]}",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"predict subprocess error: {e}")


def _normalize_prob(obj: Dict[str, Any]) -> float:
    for k in ("prob", "probability_over", "probability", "confidence"):
        if k in obj:
            v = float(obj[k])
            if v > 1.0:
                v = v / 100.0
            return max(0.0, min(1.0, v))
    raise ValueError("Predictor returned no probability field")


@router.post("/predict")
async def predict(req: Request):
    # Parse & validate input
    try:
        payload = await req.json()
    except Exception:
        raw = (await req.body()).decode("utf-8", "ignore")
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {raw[:300]}")

    inp = PredictInput.model_validate(payload)
    features: Dict[str, Any] = dict(inp.features or {})
    prop_type: str = inp.prop_type

    if not features:
        raise HTTPException(status_code=400, detail="features required")
    if not prop_type:
        raise HTTPException(status_code=400, detail="prop_type is required")

    canonical = get_canonical_model_name(prop_type) or str(prop_type)

    # internal alias used only for model input, not DB
    if "line" not in features and "prop_value" in features:
        try:
            features["line"] = float(features["prop_value"])
        except Exception:
            pass

    used_model = False
    backend = None
    model_tag = None
    t0 = time.time()

    # Choose backend **inside** the request
    try:
        if FORCE_SUBPROC:
            out = _call_predict_subprocess(canonical, features)
            used_model, backend = True, "subprocess"
        else:
            # try module first; if it fails, fall back to subprocess
            try:
                out = _call_predict_module(canonical, features)
                used_model, backend = True, "module"
            except Exception:
                out = _call_predict_subprocess(canonical, features)
                used_model, backend = True, "subprocess"
    except HTTPException:
        raise
    except Exception as e:
        # Stub so UI flow continues
        print(f"⚠️ predict fallback: {e}")
        out = {"prob": 0.5, "stub": True}
        used_model, backend = False, None

    try:
        prob = _normalize_prob(out)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"predictor did not return prob: {e}")

    model_tag = out.get("model") or out.get("model_name") or out.get("algo") or ("blend(lr,rf)" if "components" in out else None)
    dt_ms = int((time.time() - t0) * 1000)

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
        "stub": not used_model or bool(out.get("stub")),
        "features_count": len(features),
        "elapsed_ms": dt_ms,
    }
    passthrough = {k: v for k, v in out.items() if k not in {"prob", "probability", "probability_over", "confidence"}}

    return {"prob": prob, "commit_token": token, "meta": meta, **passthrough}
