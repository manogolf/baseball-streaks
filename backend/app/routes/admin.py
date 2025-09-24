# backend/routes/admin.py
import os
import io
import datetime as dt
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
    sport: str = Query("nhl"),
    x_auth: str | None = Header(None, convert_underscores=False),
):
    token = os.getenv("EXPORT_TOKEN")
    if not token or x_auth != token:
        raise HTTPException(status_code=401, detail="unauthorized")

    sport = sport.lower()
    if sport not in VALID_SPORTS:
        raise HTTPException(status_code=400, detail=f"unsupported sport: {sport}")

    db_url = _get_db_url(sport)
    today = dt.datetime.utcnow().date().isoformat()
    root = Path("/var/data/proppadia") / sport / "exports" / today
    sog_csv = root / "train_nhl_sog_v2.csv"
    goalie_csv = root / "train_goalie_saves_v2.csv"

    # resolve refresh.sql path (repo root / scripts/refresh.sql or backend/../scripts/refresh.sql)
    here = Path(__file__).resolve()
    refresh_sql_path = (here.parent.parent.parent / "scripts" / "refresh.sql").resolve()
    if not refresh_sql_path.exists():
        # try when scripts/ is at repo root and app-dir=backend
        refresh_sql_path = (here.parent.parent / "scripts" / "refresh.sql").resolve()
    if not refresh_sql_path.exists():
        raise HTTPException(status_code=500, detail="scripts/refresh.sql not found")

    # connect and run
    using_psycopg3 = hasattr(psycopg, "connect") and "psycopg" in psycopg.__name__ and not psycopg.__name__.endswith("2")
    try:
        if using_psycopg3:
            with psycopg.connect(db_url, autocommit=True) as conn:
                _run_sql(conn, refresh_sql_path.read_text(encoding="utf-8"))
                _copy_to_csv(conn,
                    "COPY (SELECT * FROM nhl.export_training_nhl_sog_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    sog_csv)
                _copy_to_csv(conn,
                    "COPY (SELECT * FROM nhl.export_training_goalie_saves_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    goalie_csv)
        else:
            conn = psycopg.connect(db_url)  # psycopg2.connect
            conn.autocommit = True
            try:
                _run_sql(conn, refresh_sql_path.read_text(encoding="utf-8"))
                _copy_to_csv(conn,
                    "COPY (SELECT * FROM nhl.export_training_nhl_sog_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    sog_csv)
                _copy_to_csv(conn,
                    "COPY (SELECT * FROM nhl.export_training_goalie_saves_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    goalie_csv)
            finally:
                conn.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"export failed: {e}")

    return {
        "ok": True,
        "sport": sport,
        "paths": [str(sog_csv), str(goalie_csv)],
    }
