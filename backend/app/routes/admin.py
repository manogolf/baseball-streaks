# backend/app/routes/admin.py
import os, re, hmac, shutil
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

from fastapi import APIRouter, HTTPException, Query, Body
from fastapi.responses import FileResponse, JSONResponse

# prefer psycopg v3; fall back to psycopg2
try:
    import psycopg  # type: ignore
    _PSYCOPG_IS_V3 = True
except Exception:  # pragma: no cover
    import psycopg2 as psycopg  # type: ignore
    _PSYCOPG_IS_V3 = False

router = APIRouter()


# ----------------------------- helpers ----------------------------------------

def _safe_eq(a: str | None, b: str | None) -> bool:
    a = (a or "").strip()
    b = (b or "").strip()
    return bool(a and b and hmac.compare_digest(a, b))

def _require_auth(token: str | None):
    if not _safe_eq(token, os.getenv("EXPORT_TOKEN")):
        raise HTTPException(status_code=401, detail="unauthorized")

def _root() -> Path:
    return Path(os.getenv("EXPORT_ROOT", "/var/data/proppadia"))

def _exports_dir(day: str | None = None) -> Path:
    d = (day or date.today().isoformat()).strip()
    return _root() / "nhl" / "exports" / d

def _get_db_url() -> str:
    """
    Resolve Postgres URL from envs and normalize for psycopg.
    Prefer DATABASE_URL; fall back to POSTGRES_URL / PGDATABASE_URL.
    """
    for name in ("DATABASE_URL", "POSTGRES_URL", "PGDATABASE_URL"):
        raw = os.getenv(name)
        if not raw:
            continue
        url = raw.strip()
        # normalize sqlalchemy-style driver suffix
        if url.startswith("postgresql+"):
            url = re.sub(r"^postgresql\+[^:]+://", "postgresql://", url, count=1)
        elif url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://"):]
        return url
    raise HTTPException(status_code=500,
                        detail="DB URL not found (expected DATABASE_URL / POSTGRES_URL / PGDATABASE_URL)")

def _copy_to_csv(cur, sql: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # generous server-side timeouts for COPY
    cur.execute("SET statement_timeout = '10min';")
    cur.execute("SET lock_timeout = '30s';")
    cur.execute("SET idle_in_transaction_session_timeout = '5min';")

    if _PSYCOPG_IS_V3:
        with open(out_path, "wb") as f:
            with cur.copy(sql) as cp:
                while True:
                    chunk = cp.read()
                    if not chunk:
                        break
                    f.write(chunk)
    else:
        with open(out_path, "wb") as f:
            cur.copy_expert(sql, f)

def _exec_sqls(cur, statements: Iterable[str]) -> None:
    """Run a few DDL statements with safe timeouts."""
    cur.execute("SET statement_timeout = '10min';")
    cur.execute("SET lock_timeout = '30s';")
    cur.execute("SET idle_in_transaction_session_timeout = '5min';")
    for s in statements:
        cur.execute(s)


# ----------------------------- endpoints --------------------------------------

@router.get("/health")
def health():
    return {"status": "ok", "ts": datetime.utcnow().isoformat() + "Z"}

@router.post("/db-ping")
def db_ping(token: str | None = Query(None), token_body: dict | None = Body(None)):
    _require_auth(token or (isinstance(token_body, dict) and token_body.get("token")))
    url = _get_db_url()
    if _PSYCOPG_IS_V3:
        with psycopg.connect(url) as conn, conn.cursor() as cur:
            cur.execute("select now()")
            now = cur.fetchone()[0]
    else:
        with psycopg.connect(url) as conn:
            with conn.cursor() as cur:
                cur.execute("select now()")
                now = cur.fetchone()[0]
    return {"ok": True, "now": str(now)}

@router.post("/refresh-ready")
def refresh_ready(token: str | None = Query(None), token_body: dict | None = Body(None)):
    """
    Refresh the two materialized views used for exports.
    Runs CONCURRENTLY when possible; ignores if objects missing.
    Returns row counts after refresh.
    """
    _require_auth(token or (isinstance(token_body, dict) and token_body.get("token")))
    url = _get_db_url()

    mv_sog = "nhl.training_features_nhl_sog_v2_ready"
    mv_gsv = "nhl.training_features_goalie_saves_v2_ready"

    counts = {}
    if _PSYCOPG_IS_V3:
        with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
            # best-effort concurrent refresh
            for mv in (mv_sog, mv_gsv):
                try:
                    cur.execute(f"REFRESH MATERIALIZED VIEW CONCURRENTLY {mv};")
                except Exception:
                    try:
                        cur.execute(f"REFRESH MATERIALIZED VIEW {mv};")
                    except Exception:
                        pass
            # counts
            for mv in (mv_sog, mv_gsv):
                try:
                    cur.execute(f"SELECT COUNT(*) FROM {mv}")
                    counts[mv] = int(cur.fetchone()[0])
                except Exception:
                    counts[mv] = None
    else:
        with psycopg.connect(url) as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                for mv in (mv_sog, mv_gsv):
                    try:
                        cur.execute(f"REFRESH MATERIALIZED VIEW CONCURRENTLY {mv};")
                    except Exception:
                        try:
                            cur.execute(f"REFRESH MATERIALIZED VIEW {mv};")
                        except Exception:
                            pass
                for mv in (mv_sog, mv_gsv):
                    try:
                        cur.execute(f"SELECT COUNT(*) FROM {mv}")
                        counts[mv] = int(cur.fetchone()[0])
                    except Exception:
                        counts[mv] = None

    return {"ok": True, "counts": counts}

@router.post("/refresh-export")
def refresh_export(
    token: str | None = Query(None),                 # auth via query param
    token_body: dict | None = Body(None),           # or JSON: {"token":"..."}
):
    _require_auth(token or (isinstance(token_body, dict) and token_body.get("token")))

    out_dir = _exports_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    url = _get_db_url()
    sog_path = out_dir / "train_nhl_sog_v2.csv"
    gsv_path = out_dir / "train_goalie_saves_v2.csv"

    try:
        if _PSYCOPG_IS_V3:
            with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
                _copy_to_csv(cur,
                    "COPY (SELECT * FROM nhl.export_training_nhl_sog_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER", sog_path)
                _copy_to_csv(cur,
                    "COPY (SELECT * FROM nhl.export_training_goalie_saves_v2 ORDER BY game_date, player_id) "
                    "TO STDOUT WITH CSV HEADER", gsv_path)
                # optional sanity counts
                cur.execute("SELECT COUNT(*) FROM nhl.export_training_nhl_sog_v2")
                sog_rows = int(cur.fetchone()[0])
                cur.execute("SELECT COUNT(*) FROM nhl.export_training_goalie_saves_v2")
                gsv_rows = int(cur.fetchone()[0])
        else:
            with psycopg.connect(url) as conn:
                conn.autocommit = True
                with conn.cursor() as cur:
                    _copy_to_csv(cur,
                        "COPY (SELECT * FROM nhl.export_training_nhl_sog_v2 ORDER BY game_date, player_id) "
                        "TO STDOUT WITH CSV HEADER", sog_path)
                    _copy_to_csv(cur,
                        "COPY (SELECT * FROM nhl.export_training_goalie_saves_v2 ORDER BY game_date, player_id) "
                        "TO STDOUT WITH CSV HEADER", gsv_path)
                    cur.execute("SELECT COUNT(*) FROM nhl.export_training_nhl_sog_v2")
                    sog_rows = int(cur.fetchone()[0])
                    cur.execute("SELECT COUNT(*) FROM nhl.export_training_goalie_saves_v2")
                    gsv_rows = int(cur.fetchone()[0])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"export failed: {type(e).__name__}: {e}")

    return {
        "ok": True,
        "out_dir": str(out_dir),
        "files": [
            {"name": sog_path.name, "bytes": sog_path.stat().st_size, "rows": sog_rows},
            {"name": gsv_path.name, "bytes": gsv_path.stat().st_size, "rows": gsv_rows},
        ],
    }

@router.get("/download-export")
def download_export(
    token: str,
    which: str,                   # "sog" or "goalie"
    date_str: str | None = None,  # defaults to today
):
    _require_auth(token)
    fname = "train_nhl_sog_v2.csv" if which == "sog" else "train_goalie_saves_v2.csv"
    fpath = _exports_dir(date_str) / fname
    if not fpath.exists():
        raise HTTPException(status_code=404, detail=f"not found: {fpath}")
    return FileResponse(str(fpath), media_type="text/csv", filename=fname)

@router.get("/list-exports")
def list_exports(token: str, limit: int = Query(60, ge=1, le=365)):
    _require_auth(token)
    base = _root() / "nhl" / "exports"
    if not base.exists():
        return {"ok": True, "dates": []}
    entries = []
    for child in sorted(base.iterdir(), reverse=True):
        if not child.is_dir():
            continue
        try:
            # expect YYYY-MM-DD
            datetime.strptime(child.name, "%Y-%m-%d")
        except Exception:
            continue
        info = {"date": child.name, "files": []}
        for fname in ("train_nhl_sog_v2.csv", "train_goalie_saves_v2.csv"):
            p = child / fname
            info["files"].append({"name": fname, "exists": p.exists(), "bytes": p.stat().st_size if p.exists() else 0})
        entries.append(info)
        if len(entries) >= limit:
            break
    return {"ok": True, "dates": entries}

@router.post("/cleanup-exports")
def cleanup_exports(token: str, keep_days: int = Query(30, ge=7, le=365)):
    """
    Delete export folders older than `keep_days`.
    Safety floor = 7 days.
    """
    _require_auth(token)
    base = _root() / "nhl" / "exports"
    if not base.exists():
        return {"ok": True, "deleted": 0, "kept": 0}

    cutoff = date.today() - timedelta(days=keep_days)
    deleted = 0
    kept = 0
    for child in base.iterdir():
        if not child.is_dir():
            continue
        try:
            d = datetime.strptime(child.name, "%Y-%m-%d").date()
        except Exception:
            continue
        if d < cutoff:
            try:
                shutil.rmtree(child)
                deleted += 1
            except Exception:
                pass
        else:
            kept += 1
    return {"ok": True, "deleted": deleted, "kept": kept, "cutoff": str(cutoff)}
