# backend/app/services/commit_token.py

from __future__ import annotations
import os, hmac, json, time, hashlib, base64
from typing import Dict, Any

_SECRET = (os.getenv("COMMIT_TOKEN_SECRET") or "CHANGE_ME_COMMIT_TOKEN_SECRET").encode("utf-8")
_ALG = "HS256"

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def _unb64url(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def _sign(payload_b: bytes) -> str:
    sig = hmac.new(_SECRET, payload_b, hashlib.sha256).digest()
    return _b64url(sig)

def mint_commit_token(claims: Dict[str, Any]) -> str:
    """
    claims will be JSON-serialized and HMAC-signed.
    """
    body = json.dumps(claims, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig  = _sign(body)
    return _b64url(body) + "." + sig

def verify_commit_token(token: str) -> Dict[str, Any]:
    try:
        body_b64, sig = token.split(".", 1)
    except ValueError:
        raise ValueError("Malformed commit token")
    body = _unb64url(body_b64)
    if not hmac.compare_digest(_sign(body), sig):
        raise ValueError("Invalid commit token signature")
    claims = json.loads(body.decode("utf-8"))
    # optional TTL
    now = int(time.time())
    if "exp" in claims and now > int(claims["exp"]):
        raise ValueError("Commit token expired")
    return claims

def features_hash(features_ordered: list[str], numeric_row: Dict[str, float]) -> str:
    """
    Deterministic SHA256 over ordered numeric features.
    """
    parts = []
    for k in features_ordered:
        v = numeric_row.get(k, 0.0)
        try:
            v = float(v)
        except Exception:
            v = 0.0
        parts.append(f"{k}={v:.12g}")
    h = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return h
