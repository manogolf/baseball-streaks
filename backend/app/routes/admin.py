# backend/routes/admin.py
import os, hmac
import io
import datetime as dt
from datetime import date
from fastapi import APIRouter, Header, HTTPException, Query, Request, Body
from pathlib import Path

try:
    import psycopg
except ImportError:  # fall back if using psycopg2
    import psycopg2 as psycopg  # type: ignore


router = APIRouter()

VALID_SPORTS = {"nhl"}  # add "mlb", "nba" later

def _get_db_url(sport: str) -> str:
    if sport == "nhl":
        url = os.getenv("NHL_DB_URL") or os.getenv("SUPABASE_DB_URL")
    else:
        url = os.getenv(f"{sport.upper()}_DB_URL")
    if not url:
        raise HTTPException(status_code=500, detail=f"DB URL missing for sport={sport}")
    return url

def _run_sql(conn, sql_text: str) -> None:
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '10min';")
        cur.execute("SET lock_timeout = '30s';")
        cur.execute("SET idle_in_transaction_session_timeout = '5min';")
        cur.execute(sql_text)

def _copy_to_csv(conn, sql: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        # psycopg (v3) uses copy; psycopg2 uses copy_expert — try both
        try:
            with open(out_path, "wb") as f:
                cur.copy(sql, f)  # psycopg v3
        except Exception:
            with open(out_path, "wb") as f:
                cur.copy_expert(sql, f)  # psycopg2

@router.post("/refresh-export")
def refresh_export(
    request: Request,
    # headers (may be stripped by proxy)
    x_auth: str | None = Header(None, convert_underscores=False),
    authorization: str | None = Header(None),
    # new: accept token via query or JSON body as fallback
    token_q: str | None = Query(None, alias="token"),
    token_body: dict | None = Body(None),
    debug: str | None = Query(None),
):
    env = (os.getenv("EXPORT_TOKEN") or "").strip()

    # collect token from header, query, or body
    token = None
    if x_auth:
        token = x_auth.strip()
    elif authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif token_q:
        token = token_q.strip()
    elif isinstance(token_body, dict) and "token" in token_body and token_body["token"]:
        token = str(token_body["token"]).strip()

    dbg = (debug or "").strip().lower()
    if dbg in {"2", "verbose"}:
        return {
            "env_set": bool(env),
            "received_headers": {k.lower(): v for k, v in request.headers.items()},
            "token_sources": {
                "x-auth": bool(x_auth),
                "authorization": bool(authorization),
                "query_param": bool(token_q),
                "json_body": isinstance(token_body, dict) and "token" in token_body,
            },
        }
    if dbg in {"1", "true", "yes"}:
        return {
            "env_set": bool(env),
            "token_present": bool(token),
            "equal": bool(token) and hmac.compare_digest(token, env),
        }

    if not env or not token or not hmac.compare_digest(token, env):
        raise HTTPException(status_code=401, detail="unauthorized")

    # simple write to prove disk path
    out_dir = Path("/var/data/proppadia/nhl/exports") / date.today().isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "ping.txt").write_text("ok\n", encoding="utf-8")
    return {"ok": True, "wrote": str(out_dir / "ping.txt")}