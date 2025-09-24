# backend/routes/admin.py
import os, hmac
import io
import datetime as dt
from datetime import date
from fastapi import APIRouter, Header, HTTPException, Query
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
    x_auth: str | None = Header(None, convert_underscores=False),
    debug: bool = Query(False),
):
    env = os.getenv("EXPORT_TOKEN")
    # optional: trim accidental spaces/newlines
    x = (x_auth or "").strip()
    e = (env or "").strip()

    if debug:
        # returns only lengths & equality, never the secret
        return {
            "has_header": x_auth is not None,
            "header_len": len(x),
            "env_set": env is not None,
            "env_len": len(e),
            "equal": hmac.compare_digest(x, e),
        }

    if not e or not hmac.compare_digest(x, e):
        raise HTTPException(status_code=401, detail="unauthorized")

    # (keep the simple ping write for now)
    out_dir = Path("/var/data/proppadia/nhl/exports") / date.today().isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "ping.txt").write_text("ok\n", encoding="utf-8")
    return {"ok": True, "wrote": str(out_dir / "ping.txt")}