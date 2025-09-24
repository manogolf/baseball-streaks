# backend/app/routes/admin.py
import os
import hmac
from datetime import date
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query, Body

# prefer psycopg v3; fall back to psycopg2 if needed
try:
    import psycopg  # type: ignore
    _PSYCOPG_IS_V3 = True
except Exception:  # pragma: no cover
    import psycopg2 as psycopg  # type: ignore
    _PSYCOPG_IS_V3 = False

router = APIRouter()

# ---- helpers -----------------------------------------------------------------

def _get_db_url() -> str:
    """Resolve DB URL (NHL)."""
    url = os.getenv("NHL_DB_URL") or os.getenv("SUPABASE_DB_URL")
    if not url:
        raise HTTPException(status_code=500, detail="missing NHL_DB_URL (or SUPABASE_DB_URL)")
    return url

def _safe_eq(a: str | None, b: str | None) -> bool:
    a = (a or "").strip()
    b = (b or "").strip()
    return bool(a and b and hmac.compare_digest(a, b))

def _copy_to_csv(cur, sql: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # psycopg v3 cursor has .copy(); psycopg2 uses .copy_expert()
    if _PSYCOPG_IS_V3 and hasattr(cur, "copy"):
        with open(out_path, "wb") as f:
            cur.copy(sql, f)  # v3
    else:
        with open(out_path, "wb") as f:
            cur.copy_expert(sql, f)  # v2

# ---- endpoint ----------------------------------------------------------------

@router.post("/refresh-export")
def refresh_export(
    token: str | None = Query(None),                 # auth via query param
    token_body: dict | None = Body(None),           # ...or JSON: {"token":"..."}
):
    # ---- auth (query or body) ----
    given = token or (isinstance(token_body, dict) and token_body.get("token"))
    if not _safe_eq(given, os.getenv("EXPORT_TOKEN")):
        raise HTTPException(status_code=401, detail="unauthorized")

    # ---- resolve output dir ----
    root = Path(os.getenv("EXPORT_ROOT", "/var/data/proppadia"))
    out_dir = root / "nhl" / "exports" / date.today().isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- export CSVs from DB ----
    db_url = _get_db_url()
    sog_path = out_dir / "train_nhl_sog_v2.csv"
    gsv_path = out_dir / "train_goalie_saves_v2.csv"

    if _PSYCOPG_IS_V3:
        with psycopg.connect(db_url, autocommit=True) as conn:
            with conn.cursor() as cur:
                _copy_to_csv(
                    cur,
                    "COPY (SELECT * FROM nhl.export_training_nhl_sog_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    sog_path,
                )
                _copy_to_csv(
                    cur,
                    "COPY (SELECT * FROM nhl.export_training_goalie_saves_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    gsv_path,
                )
    else:
        with psycopg.connect(db_url) as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                _copy_to_csv(
                    cur,
                    "COPY (SELECT * FROM nhl.export_training_nhl_sog_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    sog_path,
                )
                _copy_to_csv(
                    cur,
                    "COPY (SELECT * FROM nhl.export_training_goalie_saves_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER",
                    gsv_path,
                )

    # ---- respond ----
    return {
        "ok": True,
        "out_dir": str(out_dir),
        "files": [
            {"name": sog_path.name, "bytes": sog_path.stat().st_size},
            {"name": gsv_path.name, "bytes": gsv_path.stat().st_size},
        ],
    }
