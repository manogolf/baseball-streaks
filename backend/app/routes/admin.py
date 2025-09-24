# backend/routes/admin.py
import os, hmac
import io
import datetime as dt
from datetime import date
from fastapi import APIRouter, Header, HTTPException, Query, Request
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
    x_auth: str | None = Header(None, convert_underscores=False),
    authorization: str | None = Header(None),
    debug: str | None = Query(None),
):
    # normalize debug
    dbg = (debug or "").strip().lower()
    dbg2 = dbg in {"2", "verbose"}

    env = (os.getenv("EXPORT_TOKEN") or "").strip()

    # prefer X-Auth, else Authorization: Bearer <token>
    token = None
    if x_auth:
        token = x_auth.strip()
    elif authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    # debug=2 -> echo headers as seen by FastAPI (no secrets)
    if dbg2:
        return {
            "env_set": bool(env),
            "env_len": len(env),
            "received_headers": {
                "authorization": authorization,
                "x-auth": x_auth,
                "all": {k.lower(): v for k, v in request.headers.items()},
            },
        }

    # debug=true/1 -> summary (no secrets)
    if dbg in {"true", "1", "yes"}:
        return {
            "env_set": bool(env),
            "env_len": len(env),
            "has_x_auth": x_auth is not None,
            "has_authorization": authorization is not None,
            "token_len": len(token or ""),
            "equal": bool(token) and hmac.compare_digest(token, env),
        }

    # normal auth path
    if not env or not token or not hmac.compare_digest(token, env):
        raise HTTPException(status_code=401, detail="unauthorized")

    # simple write to prove disk access
    out_dir = Path("/var/data/proppadia/nhl/exports") / date.today().isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "ping.txt").write_text("ok\n", encoding="utf-8")
    return {"ok": True, "wrote": str(out_dir / "ping.txt")}