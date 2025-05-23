// src/scripts/resolution/statExtractors.js

/**
 * Extracts the relevant stat value from a player's game data
 * based on the prop type tracked in our system.
 *
 * @param {string} propType - Normalized prop type (e.g., 'runs_scored')
 * @param {object} playerData - Boxscore or live player data from the MLB API
 * @returns {number|null} - Stat value for that prop type or null if not found
 */
export function extractStatForPropType(propType, playerData) {
  const statMap = {
    hits: playerData.hits,
    runs_scored: playerData.runs,
    rbis: playerData.rbis,
    home_runs: playerData.home_runs,
    singles:
      (playerData.hits || 0) -
      (playerData.doubles || 0) -
      (playerData.triples || 0) -
      (playerData.home_runs || 0),
    doubles: playerData.doubles,
    triples: playerData.triples,
    walks: playerData.walks,
    strikeouts_batting: playerData.strikeouts_batting,
    stolen_bases: playerData.stolen_bases,
    total_bases: playerData.total_bases,
    hits_runs_rbis:
      (playerData.hits || 0) + (playerData.runs || 0) + (playerData.rbis || 0),
    runs_rbis: (playerData.runs || 0) + (playerData.rbis || 0), // ✅ Added mapping

    // Pitching props
    outs_recorded: playerData.outs_recorded,
    strikeouts_pitching: playerData.strikeouts_pitching,
    walks_allowed: playerData.walks_allowed,
    earned_runs: playerData.earned_runs,
    hits_allowed: playerData.hits_allowed,
  };

  return statMap[propType] ?? null;
}
