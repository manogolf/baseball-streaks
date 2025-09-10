# backend/app/routes/api/prepare_prop.py
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator
from typing import Any, Dict, Optional, Tuple
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import requests

# Supabase client (used only to ensure FK target in game_info)
from scripts.shared.supabase_utils import supabase

# Team + time helpers (stable, file you provided)
from scripts.shared.team_name_map import (
    get_team_id_from_abbr,
    get_team_info_by_id,
    normalize_team_abbreviation,
)

# If these utilities exist in your repo; we fall back to local helpers if import fails
try:
    from scripts.shared.time_utils_backend import (
        getDayOfWeekET,
        getTimeOfDayBucketET,
    )
except Exception:
    # Fallbacks if your util module is missing in local runs
    def getDayOfWeekET(date_or_iso: str) -> str:
        """
        Accept 'YYYY-MM-DD' or ISO datetime; return e.g. 'Mon', 'Tue'...
        """
        s = (date_or_iso or "").strip()
        dt = None
        try:
            # ISO datetime
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            try:
                # Date only
                dt = datetime.strptime(s[:10], "%Y-%m-%d").replace(tzinfo=ZoneInfo("America/New_York"))
            except Exception:
                return "Mon"
        dt_et = dt.astimezone(ZoneInfo("America/New_York"))
        return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][dt_et.weekday()]

    def getTimeOfDayBucketET(iso_et: Optional[str]) -> str:
        """
        Very light bucketization like v1: 'day' (<17:00 ET) else 'evening'.
        """
        if not iso_et:
            return "evening"
        try:
            dt = datetime.fromisoformat(iso_et.replace("Z", "+00:00"))
            dt_et = dt.astimezone(ZoneInfo("America/New_York"))
            return "day" if dt_et.hour < 17 else "evening"
        except Exception:
            return "evening"


router = APIRouter()

# Pitching props (soft metadata only)
PITCHING_PROPS = {
    "strikeouts_pitching", "outs_recorded", "earned_runs",
    "hits_allowed", "walks_allowed"
}


class PrepareInput(BaseModel):
    # User-entered or resolved on the client
    player_id: Optional[int] = None
    player_name: Optional[str] = None
    team_id: Optional[int] = None
    team_abbr: Optional[str] = None

    game_date: str  # 'YYYY-MM-DD' (today or future)
    prop_type: str
    prop_value: Optional[float] = None  # aka "line"
    over_under: Optional[str] = None    # "over" | "under"

    @field_validator("game_date")
    @classmethod
    def _validate_date(cls, v: str) -> str:
        try:
            # Normalize to 'YYYY-MM-DD'
            d = datetime.strptime(v[:10], "%Y-%m-%d")
            return d.strftime("%Y-%m-%d")
        except Exception:
            raise ValueError("game_date must be YYYY-MM-DD")

    @field_validator("over_under")
    @classmethod
    def _normalize_ou(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        s = v.strip().lower()
        if s not in {"over", "under"}:
            raise ValueError("over_under must be 'over' or 'under'")
        return s

    @field_validator("team_abbr")
    @classmethod
    def _norm_abbr(cls, v: Optional[str]) -> Optional[str]:
        return normalize_team_abbreviation(v) if v else v


def _fetch_schedule_one(date_yyyy_mm_dd: str) -> Dict[str, Any]:
    """
    Fetch MLB schedule for a single date via StatsAPI.
    """
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={date_yyyy_mm_dd}"
    r = requests.get(url, timeout=10)
    if not r.ok:
        raise HTTPException(502, f"MLB schedule fetch failed ({r.status_code})")
    return r.json()


def _pick_team_game(schedule_json: Dict[str, Any], team_id: int) -> Dict[str, Any]:
    """
    From a schedule day payload, return the game object involving team_id.
    Raises if none.
    """
    dates = schedule_json.get("dates") or []
    for day in dates:
        for g in day.get("games", []):
            home = g.get("teams", {}).get("home", {}).get("team", {}) or {}
            away = g.get("teams", {}).get("away", {}).get("team", {}) or {}
            if int(home.get("id", -1)) == int(team_id) or int(away.get("id", -1)) == int(team_id):
                return g
    raise HTTPException(404, f"No scheduled game for team_id {team_id} on {schedule_json.get('dates',[{'date':'?'}])[0].get('date','?')}.")


def _utc_to_et_iso(utc_iso: str) -> str:
    """
    Convert MLB 'gameDate' (UTC) to ET ISO string (no microseconds).
    """
    dt_utc = datetime.fromisoformat(utc_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    dt_et = dt_utc.astimezone(ZoneInfo("America/New_York"))
    return dt_et.replace(microsecond=0).isoformat()


def _extract_game_summary(g: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build a compact summary from schedule game object.
    """
    game_id = int(g.get("gamePk"))
    teams = g.get("teams", {})
    home_team = teams.get("home", {}).get("team", {}) or {}
    away_team = teams.get("away", {}).get("team", {}) or {}

    # Abbreviations (StatsAPI often includes; if not, fallback using ID map)
    home_abbr = home_team.get("abbreviation")
    away_abbr = away_team.get("abbreviation")
    if not home_abbr:
        info = get_team_info_by_id(int(home_team.get("id")))
        home_abbr = info["abbr"] if info else None
    if not away_abbr:
        info = get_team_info_by_id(int(away_team.get("id")))
        away_abbr = info["abbr"] if info else None

    # Probable starters if present (optional)
    home_prob = teams.get("home", {}).get("probablePitcher", {}) or {}
    away_prob = teams.get("away", {}).get("probablePitcher", {}) or {}
    sp_home_id = int(home_prob.get("id")) if home_prob.get("id") else None
    sp_away_id = int(away_prob.get("id")) if away_prob.get("id") else None

    # UTC → ET
    gameDate = g.get("gameDate")  # UTC ISO
    game_time_et = _utc_to_et_iso(gameDate) if gameDate else None
    game_date = gameDate[:10] if gameDate else None

    return {
        "game_id": game_id,
        "home_team_id": int(home_team.get("id")),
        "away_team_id": int(away_team.get("id")),
        "home_abbr": home_abbr,
        "away_abbr": away_abbr,
        "game_time_et": game_time_et,
        "game_date": game_date,
        "sp_home_id": sp_home_id,
        "sp_away_id": sp_away_id,
    }


def _ensure_game_info_row(summary: Dict[str, Any]) -> None:
    """
    Best-effort upsert into public.game_info so /props/add won’t violate FK.
    Safe no-op on conflict. Swallows errors (non-fatal for prepareProp).
    """
    try:
        # Exists?
        ex = (
            supabase.from_("game_info")
            .select("game_id")
            .eq("game_id", summary["game_id"])
            .limit(1)
            .execute()
        )
        if getattr(ex, "data", []) or []:
            return

        payload = {
            "game_id": summary["game_id"],
            "game_date": summary["game_date"],
            "home_team_id": summary["home_team_id"],
            "away_team_id": summary["away_team_id"],
            "home_team_abbr": summary["home_abbr"],
            "away_team_abbr": summary["away_abbr"],
            "game_time": summary["game_time_et"],  # timezone-aware string ok for timestamptz
            "starting_pitcher_id_home": summary.get("sp_home_id"),
            "starting_pitcher_id_away": summary.get("sp_away_id"),
        }
        supabase.from_("game_info").upsert(payload, on_conflict="game_id").execute()
    except Exception:
        # Non-fatal: prediction flow can continue; /props/add may still fail if this insert didn’t happen.
        pass


@router.post("/prepareProp")
async def prepare_prop(req: Request) -> Dict[str, Any]:
    """
    v2 'prepare' endpoint: take minimal user input and assemble the features/context
    needed by /predict and later /props/add, without DB-first lookups.
    """
    payload = await req.json()
    inp = PrepareInput(**payload)

    # --- Resolve team_id if we only have an abbreviation ---
    team_id = inp.team_id
    if team_id is None:
        if not inp.team_abbr:
            raise HTTPException(400, "Provide team_id or team_abbr.")
        team_id = get_team_id_from_abbr(inp.team_abbr)
        if team_id is None:
            raise HTTPException(400, f"Unknown team_abbr: {inp.team_abbr}")

    # --- Minimal sanity: need player_id (client normally resolves it first) ---
    if not inp.player_id:
        raise HTTPException(400, "player_id is required (resolve name → id first).")

    # --- Pull schedule for date and pick game by team_id ---
    sched = _fetch_schedule_one(inp.game_date)
    game = _pick_team_game(sched, int(team_id))
    g = _extract_game_summary(game)

    # --- Ensure FK target present for later insert (/props/add) ---
    _ensure_game_info_row(g)

    # --- Opponent + home/away ---
    is_home = (int(team_id) == int(g["home_team_id"]))
    opponent_team_id = int(g["away_team_id"] if is_home else g["home_team_id"])

    # --- Abbreviations for model features (your hits model expects team/opponent strings) ---
    team_abbr = g["home_abbr"] if is_home else g["away_abbr"]
    opponent_abbr = g["away_abbr"] if is_home else g["home_abbr"]

    # --- Time features (ET) ---
    iso_time = g["game_time_et"]
    game_day_of_week = getDayOfWeekET(iso_time[:10] if iso_time else inp.game_date)
    time_of_day_bucket = getTimeOfDayBucketET(iso_time) if iso_time else "evening"

    # --- Probable starters (soft metadata only) ---
    starting_pitcher_id = None
    if inp.prop_type in PITCHING_PROPS:
        starting_pitcher_id = g["sp_home_id"] if is_home else g["sp_away_id"]

    # --- Build the features dict; keep it lean (predict fills missing with 0) ---
    features: Dict[str, Any] = {
        # IDs + core
        "player_id": int(inp.player_id),
        "team_id": int(team_id),
        "game_id": int(g["game_id"]),
        "game_date": inp.game_date,

        # model inputs (hits model includes these)
        "team": team_abbr,
        "opponent": opponent_abbr,

        # context used by other models/analytics
        "opponent_encoded": opponent_team_id,
        "is_home": is_home,
        "game_time": iso_time,
        "game_day_of_week": game_day_of_week,
        "time_of_day_bucket": time_of_day_bucket,

        # user-entered prop details (use canonical field names)
        "prop_type": inp.prop_type,
        "line": inp.prop_value,          # some code still calls it 'line'
        "prop_value": inp.prop_value,    # use this for inserts/dedupe
        "over_under": (inp.over_under or "over"),
    }

    # Pitching-only soft indicator
    if inp.prop_type in PITCHING_PROPS:
        features["starting_pitcher_id"] = starting_pitcher_id

    # Optionally echo back helpful names (not required by model)
    if inp.player_name:
        features["player_name"] = inp.player_name
    features["team_abbr"] = team_abbr
    features["opponent_team_id"] = opponent_team_id

    return {"features": features}
