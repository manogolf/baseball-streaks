# backend/app/routes/api/players.py

from fastapi import APIRouter, HTTPException, Query
from typing import Optional, List, Dict, Any
import unicodedata, difflib

from app.services.supabase_queries import (
    players_all,
    player_lookup,
    players_search,
    players_by_team,
)
from scripts.shared.team_name_map import (
    get_team_id_from_abbr,
)
from scripts.shared.prop_utils import get_latest_team_for_player
from scripts.shared.supabase_utils import supabase

router = APIRouter()


# ---------- helpers ----------
def _strip_accents(s: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFKD", s)
        if unicodedata.category(ch) != "Mn"
    )

def _norm_name(s: str) -> str:
    s = _strip_accents(s or "")
    s = s.replace("’", "'").replace("‘", "'").replace(".", "")
    s = " ".join(s.split())
    return s.strip()

def _best_match(target_norm: str, rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    best, best_score = None, 0.0
    for r in rows:
        nm = _norm_name(str(r.get("player_name", "")))
        score = difflib.SequenceMatcher(None, target_norm.lower(), nm.lower()).ratio()
        if score > best_score:
            best, best_score = r, score
    return best if best_score >= 0.75 else None  # tune threshold if needed


# ---------- routes ----------
@router.get("/players")
def players_list_all():
    return players_all()

@router.get("/players/lookup")
def players_lookup_route(
    player_id: str | None = Query(None),
    player_name: str | None = Query(None),
):
    if not player_id and not player_name:
        raise HTTPException(status_code=400, detail="Provide player_id or player_name")
    row = player_lookup(player_id=player_id, player_name=player_name)
    if not row:
        raise HTTPException(status_code=404, detail="player not found")
    return {"ok": True, "data": row}

@router.get("/players/search")
def players_search_route(
    q: str = Query(..., min_length=1, max_length=64),
    limit: int = Query(10, ge=1, le=50),
):
    return {"ok": True, "data": players_search(q, limit)}

@router.get("/players/by_team")
def players_by_team_route(
    team_id: int | None = Query(None, ge=1),
    team: str | None = Query(None),
):
    data = players_by_team(team_id=team_id, team=team)
    return {"ok": True, "data": data}

# Resolve by NAME → {player_id, team_id}
@router.get("/players/resolve")
def resolve_player(
    name: str = Query(..., min_length=2),
    date: Optional[str] = None,  # accepted for compatibility; not used
):
    """
    Resolve by NAME ONLY (case/diacritic tolerant).
    Reads from public.player_ids and returns the most recent team (by updated_at).
    """
    raw = name.strip()
    norm = _norm_name(raw)
    if not norm:
        raise HTTPException(400, "empty name")

    # If a numeric string sneaks in, treat it as an id shortcut
    if raw.isdigit():
        pid = int(raw)
        team_id = None
        try:
            _abbr, tid = get_latest_team_for_player(pid)
            if tid:
                team_id = int(tid)
        except Exception:
            team_id = None
        if team_id is None:
            raise HTTPException(status_code=404, detail="Team not found for player")
        return {"player_id": pid, "name": raw, "team_id": team_id}
    # 1) Broad ILIKE on raw (fast path)
    rows: List[Dict[str, Any]] = []
    try:
        res = (
            supabase.from_("player_ids")
            .select("player_id, player_name, team, team_id, updated_at")
            .ilike("player_name", f"%{raw}%")
            .order("updated_at", desc=True)
            .limit(50)
            .execute()
        )
        rows = getattr(res, "data", []) or []
    except Exception:
        rows = []
    
    # 2) If empty, broaden search in accent-friendly way:
    tokens = [t for t in norm.split(" ") if t]

    # 2a) try FIRST token only (avoids the accent on the last name)
    if not rows and tokens:
        try:
            res2 = (
                supabase.from_("player_ids")
                .select("player_id, player_name, team, team_id, updated_at")
                .ilike("player_name", f"%{tokens[0]}%")
                .order("updated_at", desc=True)
                .limit(100)
                .execute()
            )
            rows = getattr(res2, "data", []) or []
        except Exception:
            rows = []

    # 2b) if still empty and we have a last token, try that alone
    if not rows and len(tokens) > 1:
        try:
            res3 = (
                supabase.from_("player_ids")
                .select("player_id, player_name, team, team_id, updated_at")
                .ilike("player_name", f"%{tokens[-1]}%")
                .order("updated_at", desc=True)
                .limit(100)
                .execute()
            )
            rows = getattr(res3, "data", []) or []
        except Exception:
            rows = []

    # 3) Pick best by normalized fuzzy ratio
    cand = _best_match(norm, rows) if rows else None
    if not cand:
        raise HTTPException(status_code=404, detail="Player not found")

    pid = int(cand["player_id"])
    # Prefer a definitive TEAM ID; fall back through several sources
    team_id: Optional[int] = None
    try:
        _abbr, latest_tid = get_latest_team_for_player(pid)
        if latest_tid:
            team_id = int(latest_tid)
    except Exception:
        team_id = None

    if team_id is None and cand.get("team_id") is not None:
        try:
            team_id = int(cand["team_id"])
        except Exception:
            team_id = None

    if team_id is None and cand.get("team"):
        try:
            mapped_tid = get_team_id_from_abbr(str(cand["team"]).strip())
            if mapped_tid is not None:
                team_id = int(mapped_tid)
        except Exception:
            team_id = None

    if team_id is None:
        raise HTTPException(status_code=404, detail="Team not found for player")

    return {
        "player_id": pid,
        "name": cand.get("player_name") or raw,
        "team_id": team_id,
    }