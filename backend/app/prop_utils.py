# backend/app/prop_utils.py

from __future__ import annotations

from typing import Optional, Tuple
import json
from urllib.request import urlopen

# Optional MLB StatsAPI fallback (pip install MLB-StatsAPI)
try:
    import statsapi
except Exception:  # pragma: no cover
    statsapi = None

# -------------------------------------------------------------------
# Model map + helpers (unchanged behavior)
# -------------------------------------------------------------------

PROP_MODEL_MAP = {
    "hits": "hits",
    "home_runs": "home_runs",
    "rbis": "rbis",
    "strikeouts_pitching": "strikeouts_pitching",
    "strikeouts_batting": "strikeouts_batting",
    "runs_scored": "runs_scored",
    "walks": "walks",
    "doubles": "doubles",
    "triples": "triples",
    "outs_recorded": "outs_recorded",
    "earned_runs": "earned_runs",
    "hits_allowed": "hits_allowed",
    "walks_allowed": "walks_allowed",
    "stolen_bases": "stolen_bases",
    "total_bases": "total_bases",
    "hits_runs_rbis": "hits_runs_rbis",
    "runs_rbis": "runs_rbis",
    "singles": "singles",
}

def normalize_prop_type(prop_type: str) -> str:
    return (
        prop_type.lower()
        .replace("(", "")
        .replace(")", "")
        .replace(" + ", "_")
        .replace(" ", "_")
        .strip("_")
    )

def get_canonical_model_name(prop_type: str) -> Optional[str]:
    key = normalize_prop_type(prop_type)
    return PROP_MODEL_MAP.get(key)

# -------------------------------------------------------------------
# DB + mapping helpers (ID-first; matches public.player_ids schema)
# -------------------------------------------------------------------

from backend.scripts.shared.supabase_utils import supabase
from backend.scripts.shared.team_name_map import (
    normalizeTeamAbbreviation as norm_abbr,  # e.g., "AZ" -> "ARI"
    getTeamIdFromAbbr,                       # abbr -> team_id
)

def get_player_id_by_name(name: str) -> Optional[int]:
    """
    Resolve MLB player_id using your Supabase table first:
      table: public.player_ids
      columns: player_name (text), player_id (text)
    Fallback to MLB StatsAPI if DB has no match.
    """
    if not name:
        return None
    q = name.strip()

    # 1) Exact match
    try:
        res = (
            supabase.from_("player_ids")
            .select("player_id, player_name")
            .eq("player_name", q)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", []) or []
        if rows:
            return int(rows[0]["player_id"])
    except Exception:
        pass

    # 2) Case-insensitive contains
    try:
        res = (
            supabase.from_("player_ids")
            .select("player_id, player_name")
            .ilike("player_name", f"%{q}%")
            .limit(5)
            .execute()
        )
        rows = getattr(res, "data", []) or []
        if rows:
            # Prefer case-insensitive exact among results
            for r in rows:
                if str(r.get("player_name", "")).lower() == q.lower():
                    return int(r["player_id"])
            return int(rows[0]["player_id"])
    except Exception:
        pass

    # 3) MLB StatsAPI fallback
    if statsapi:
        try:
            candidates = statsapi.lookup_player(q) or []
            exact = next(
                (c for c in candidates if str(c.get("fullName", "")).lower() == q.lower()),
                None,
            )
            if exact and "id" in exact:
                return int(exact["id"])
            active = next((c for c in candidates if c.get("active") and "id" in c), None)
            if active:
                return int(active["id"])
            if candidates and "id" in candidates[0]:
                return int(candidates[0]["id"])
        except Exception:
            pass

    return None


def get_latest_team_for_player(player_id: int) -> Tuple[Optional[str], Optional[int]]:
    """
    From public.player_ids, return (team_abbr, team_id) for the given player_id,
    preferring the most recently updated row.
    Columns: player_id (text), team (abbr), team_id (bigint), updated_at/created_at.
    """
    try:
        res = (
            supabase.from_("player_ids")
            .select("team, team_id, updated_at, created_at")
            .eq("player_id", str(player_id))  # stored as TEXT
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = getattr(res, "data", []) or []
        if not rows:
            return None, None

        team_abbr = norm_abbr(rows[0].get("team"))
        tid = rows[0].get("team_id")
        if tid is None and team_abbr:
            tid = getTeamIdFromAbbr(team_abbr)
        return team_abbr, (int(tid) if tid is not None else None)
    except Exception:
        return None, None


def get_team_abbr_from_team_id(team_id: int) -> Optional[str]:
    """
    Derive team abbreviation from team_id. If you later add a local id->abbr
    map in Python, prefer that; this HTTP fallback is fine for now.
    """
    if not team_id:
        return None
    try:
        with urlopen(f"https://statsapi.mlb.com/api/v1/teams/{team_id}") as resp:
            team = json.load(resp)
        teams = team.get("teams") or []
        if not teams:
            return None
        return teams[0].get("abbreviation")
    except Exception:
        return None


def find_game_id_by_team_id_and_date(*, team_id: int, game_date: str) -> Optional[int]:
    """
    Use MLB StatsAPI schedule to find the gamePk for team/date.
    Returns the first gamePk (extend if you need doubleheader handling).
    """
    if not team_id or not game_date:
        return None
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={game_date}&teamId={team_id}"
    try:
        with urlopen(url) as resp:
            data = json.load(resp)
        dates = data.get("dates") or []
        if not dates:
            return None
        games = dates[0].get("games") or []
        if not games:
            return None
        return int(games[0]["gamePk"])
    except Exception:
        return None


def find_game_id_by_team_and_date(*, team_abbr: str, game_date: str) -> Optional[int]:
    """
    Back-compat helper: abbr + date -> gamePk.
    Prefer find_game_id_by_team_id_and_date in new code.
    """
    if not team_abbr or not game_date:
        return None
    abbr = norm_abbr(team_abbr)
    team_id = getTeamIdFromAbbr(abbr)
    if team_id is None:
        return None
    return find_game_id_by_team_id_and_date(team_id=team_id, game_date=game_date)
