#  backend/app/security/commit_token.py

import os, hmac, hashlib, base64, json, time
from fastapi import HTTPException
from typing import Dict, Any

SECRET = (os.getenv("PROP_COMMIT_SECRET") or "dev-secret-change-me").encode()
TTL_SEC = int(os.getenv("PROP_COMMIT_TTL_SEC") or "600")  # 10 min

def _b64(x: bytes) -> str:
    return base64.urlsafe_b64encode(x).decode().rstrip("=")

def _unb64(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def make_commit_token(payload: Dict[str, Any]) -> str:
    body = dict(payload)
    body["ts"] = int(time.time())
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
    sig = hmac.new(SECRET, raw, hashlib.sha256).digest()
    return "v1." + _b64(raw) + "." + _b64(sig)

def verify_commit_token(token: str) -> Dict[str, Any]:
    try:
        v, b64raw, b64sig = token.split(".")
        if v != "v1":
            raise ValueError("bad version")
        raw = _unb64(b64raw)
        sig = _unb64(b64sig)
        expect = hmac.new(SECRET, raw, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expect):
            raise ValueError("bad sig")
        body = json.loads(raw)
        if int(time.time()) - int(body["ts"]) > TTL_SEC:
            raise ValueError("expired")
        return body
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid commit_token: {e}")
