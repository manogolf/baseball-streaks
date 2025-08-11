# backend/app/services/team_map.py
# Re-export the shared team mapping utilities to avoid duplication/divergence.

from backend.scripts.shared.team_name_map import (
    # Canonical JS-style names
    normalizeTeamAbbreviation,
    getTeamIdFromAbbr,
    getTeamInfoByAbbr,
    getTeamInfoByID,
    getTeamInfoById,
    getFullTeamName,
    getOpponentAbbreviation,
    teamNameMap,
    teamIdMap,
    abbrToIdMap,
    isValidMLBTeam,
)

# Backward-compatible aliases (snake_case) for existing code
normalize_abbr = normalizeTeamAbbreviation
abbr_to_team_id = getTeamIdFromAbbr
team_id_from_abbr = getTeamIdFromAbbr

__all__ = [
    # canonical
    "normalizeTeamAbbreviation",
    "getTeamIdFromAbbr",
    "getTeamInfoByAbbr",
    "getTeamInfoByID",
    "getTeamInfoById",
    "getFullTeamName",
    "getOpponentAbbreviation",
    "teamNameMap",
    "teamIdMap",
    "abbrToIdMap",
    "isValidMLBTeam",
    # aliases
    "normalize_abbr",
    "abbr_to_team_id",
    "team_id_from_abbr",
]
