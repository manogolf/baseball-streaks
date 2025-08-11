# backend/app/security/commit_token.py
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any, Dict

def _b64e(b: bytes) -> str:
    """URL-safe base64 encode without padding."""
    return base64.urlsafe_b64encode(b).decode("utf-8").rstrip("=")

def _b64d(s: str) -> bytes:
    """URL-safe base64 decode handling missing padding."""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def mint_commit_token(
    *,
    prob: float,
    prop_type: str,
    features: dict,
    ttl_seconds: int = 600,
    secret: str | None = None,
    version: str = "v1",
) -> str:
    """Return token: '{version}.{payload}.{sig_hex}' where payload is base64url(JSON)."""
    secret = secret or os.getenv("PROP_COMMIT_SECRET", "dev-secret-change-me")
    now = int(time.time())
    payload_obj = {
        "features": features,
        "prob": float(prob),
        "prop_type": str(prop_type),
        "ts": now,
        "exp": now + int(ttl_seconds),
    }
    payload = _b64e(json.dumps(payload_obj, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{version}.{payload}.{sig}"

def verify_commit_token(
    token: str,
    *,
    ttl_seconds: int | None = None,
    secret: str | None = None,
) -> Dict[str, Any]:
    """Verify token minted above; return decoded payload or raise ValueError."""
    secret = secret or os.getenv("PROP_COMMIT_SECRET", "dev-secret-change-me")

    try:
        version, payload, sig = token.split(".", 2)
    except ValueError:
        raise ValueError("Invalid commit_token format")

    if version != "v1":
        raise ValueError(f"Unsupported token version: {version}")

    expected_sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_sig, sig):
        raise ValueError("Invalid commit_token signature")

    try:
        obj = json.loads(_b64d(payload).decode("utf-8"))
    except Exception as e:
        raise ValueError(f"Invalid commit_token payload: {e}")

    now = int(time.time())
    if ttl_seconds is not None:
        ts = int(obj.get("ts", 0))
        if now - ts > int(ttl_seconds):
            raise ValueError("commit_token expired (ttl)")
    else:
        exp = int(obj.get("exp", 0))
        if exp and now > exp:
            raise ValueError("commit_token expired")

    if "features" not in obj or "prop_type" not in obj or "prob" not in obj:
        raise ValueError("commit_token payload missing required fields")

    obj["version"] = version
    return obj
