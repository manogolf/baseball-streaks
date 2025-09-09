#  backend/app/routes/api/prepare_prop.py

import os
from supabase import create_client
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, AliasChoices, ConfigDict
from typing import Optional, Dict, Any, Tuple
from sqlalchemy import text, create_engine
from sqlalchemy.exc import ProgrammingError
from backend.scripts.shared.enrich_game_context import enrich_game_context
from backend.scripts.shared.prop_utils import (
    get_player_id_by_name,
    get_latest_team_for_player,
    get_team_abbr_from_team_id,           # ✅ add
    find_game_id_by_team_id_and_date,     # ✅ add (ID-first)
)
router = APIRouter()

_engine = None
def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    return _engine

def _resolve_team_and_opponent(conn, player_id: int, game_id: int) -> Tuple[int, str, str]:
    """
    Returns (team_id, team_abbr, opp_abbr) for (player_id, game_id).

    • team_id comes from public.player_team_by_game (immutable id)
    • team/opponent strings come from public.player_stats for that game
      (only to satisfy model feature columns; not used for logic)

    Raises ValueError if either piece is missing.
    """
    # 1) team_id from canonical table
    tid = conn.execute(
        text("""
            SELECT team_id
            FROM public.player_team_by_game
            WHERE player_id = :pid AND game_id = :gid
            LIMIT 1
        """),
        {"pid": player_id, "gid": game_id}
    ).scalar()

    if tid is None:
        raise ValueError("team_id not found for player/game")

    # 2) team/opponent abbr from player_stats (for features only)

    sql = """
    SELECT
    COALESCE(ptbg.team_id, mtp.team_id, tr.team_id) AS team_id,
    ps.team,
    ps.opponent
    FROM public.player_stats ps
    LEFT JOIN public.player_team_by_game ptbg
    ON ptbg.player_id = ps.player_id
    AND ptbg.game_id   = ps.game_id
    AND ptbg.team_id IS NOT NULL
    LEFT JOIN LATERAL (
    SELECT m.team_id
    FROM public.model_training_props m
    WHERE m.player_id = ps.player_id
        AND m.game_id   = ps.game_id
        AND m.team_id IS NOT NULL
    ORDER BY m.created_at DESC
    LIMIT 1
    ) mtp ON TRUE
    LEFT JOIN public.teams_resolver tr
    ON tr.abbr = ps.team
    WHERE ps.player_id = %(pid)s AND ps.game_id = %(gid)s
    LIMIT 1
    """
    row = conn.exec_driver_sql(sql, {"pid": int(player_id), "gid": int(game_id)}).mappings().first()

    if not row or not row["team"] or not row["opponent"]:
        raise ValueError("team/opponent not found in player_stats for player/game")

    team_abbr = str(row["team"]).strip().upper()
    opp_abbr  = str(row["opponent"]).strip().upper()
    return int(tid), team_abbr, opp_abbr


class PreparePropInput(BaseModel):
    # identifiers: accept either id or name; enforce presence in endpoint code
    player_id: Optional[int] = Field(default=None, validation_alias=AliasChoices("player_id", "playerId"))
    player_name: Optional[str] = Field(default=None, validation_alias=AliasChoices("player_name", "playerName"))

    # game: accept either game_id or game_date; enforce presence in endpoint code
    game_id: Optional[int] = Field(default=None, validation_alias=AliasChoices("game_id", "gameId"))
    game_date: Optional[str] = Field(default=None, validation_alias=AliasChoices("game_date", "gameDate"))

    # prop
    prop_type: str = Field(validation_alias=AliasChoices("prop_type", "propType"))
    # allow both "line" and legacy "prop_value", but OPTIONAL (we can score both sides)
    line: Optional[float] = Field(default=None, validation_alias=AliasChoices("line", "prop_value"))

    # legacy/ignored inputs (kept only for compatibility; backend will resolve)
    over_under: Optional[str] = Field(default=None, validation_alias=AliasChoices("over_under", "overUnder"))
    team_abbr: Optional[str] = Field(default=None, validation_alias=AliasChoices("team", "team_abbr", "teamAbbr"))
    team_id: Optional[int] = Field(default=None, validation_alias=AliasChoices("team_id", "teamId"))

    # ignore any extra keys from the UI
    model_config = ConfigDict(extra="ignore")

@router.post("/prepareProp")
async def prepare_prop(req: Request) -> Dict[str, Any]:
    payload = await req.json()
    inp = PreparePropInput(**payload)

    # 1) player_id
    pid = inp.player_id or (get_player_id_by_name(inp.player_name) if inp.player_name else None)
    if not pid:
        raise HTTPException(400, "Provide playerId or playerName.")

    engine = get_engine()
    with engine.begin() as conn:
        # 2) game_id (prefer provided; else look up by date)
        gid = inp.game_id
        if not gid:
            if not inp.game_date:
                raise HTTPException(400, "Provide gameId or gameDate.")
            gid = conn.execute(
                text("""
                    SELECT game_id
                    FROM public.player_stats
                    WHERE player_id = :pid AND game_date = :gdt
                    LIMIT 1
                """),
                {"pid": pid, "gdt": inp.game_date},
            ).scalar()
            if not gid:
                raise HTTPException(404, f"No game found for playerId={pid} on {inp.game_date}")

        # 3) team_id + feature strings (single resolver; immutable ID + abbrs)
        row = None
        try:
            # If SQL helper exists, prefer it
            row = conn.execute(
                text("SELECT team_id, team, opponent FROM public.resolve_team_context(:pid,:gid)"),
                {"pid": pid, "gid": gid},
            ).mappings().first()
        except Exception:
            row = None

        if not row or row.get("team_id") is None:
            # Inline fallback that coalesces across sources
            row = conn.execute(
                text("""
                    WITH base AS (
                      SELECT :pid::bigint AS player_id, :gid::bigint AS game_id
                    )
                    SELECT
                      COALESCE(ptbg.team_id, mtp.team_id, tr.team_id) AS team_id,
                      ps.team,
                      ps.opponent
                    FROM base b
                    LEFT JOIN public.player_stats ps
                      ON ps.player_id = b.player_id AND ps.game_id = b.game_id
                    LEFT JOIN public.player_team_by_game ptbg
                      ON ptbg.player_id = b.player_id AND ptbg.game_id = b.game_id
                      AND ptbg.team_id IS NOT NULL
                    LEFT JOIN LATERAL (
                      SELECT m.team_id
                      FROM public.model_training_props m
                      WHERE m.player_id = b.player_id
                        AND m.game_id   = b.game_id
                        AND m.team_id IS NOT NULL
                      ORDER BY m.created_at DESC
                      LIMIT 1
                    ) mtp ON TRUE
                    LEFT JOIN public.teams_resolver tr
                      ON tr.abbr = ps.team
                    LIMIT 1
                """),
                {"pid": pid, "gid": gid},
            ).mappings().first()

        if not row or row.get("team_id") is None:
            raise HTTPException(404, "Could not determine teamId for player/game")

        team_id   = int(row["team_id"])
        team_abbr = (row.get("team") or "").strip() or None
        opp_abbr  = (row.get("opponent") or "").strip() or None

        # 4) optional enrichment (safe to send abbrs if enrich expects them)
        ctx = enrich_game_context({
            "player_id": pid,
            "team_id": team_id,
            "team": team_abbr,
            "game_id": gid,
            "game_date": inp.game_date,
        })

    # Build features payload (line may be None)
    features = {
        "player_id": pid,
        "game_id": gid,
        "game_date": inp.game_date,
        "prop_type": inp.prop_type,
        "line": inp.line,
        "team_id": team_id,   # immutable; for consistency only
        "team": team_abbr,    # models expect these string features
        "opponent": opp_abbr,
        **(ctx or {}),
    }
    return {"features": features}
