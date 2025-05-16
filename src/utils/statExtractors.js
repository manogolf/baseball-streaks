// src/utils/statExtractors.js

/**
 * Extracts the relevant stat value from a player's game data
 * based on the prop type tracked in our system.
 *
 * @param {string} propType - Normalized prop type (e.g., 'runs_scored')
 * @param {object} playerData - Boxscore or live player data from the MLB API
 * @returns {number|null} - Stat value for that prop type or null if not found
 */
export function extractStatForPropType(propType, playerData) {
  const batting = playerData?.stats?.batting || {};
  const pitching = playerData?.stats?.pitching || {};

  const statMap = {
    hits: batting.hits,
    runs_scored: batting.runs,
    rbis: batting.rbi,
    home_runs: batting.homeRuns,
    singles:
      batting.hits -
      (batting.doubles || 0) -
      (batting.triples || 0) -
      (batting.homeRuns || 0),
    doubles: batting.doubles,
    triples: batting.triples,
    walks: batting.baseOnBalls,
    strikeouts_batting: batting.strikeOuts,
    stolen_bases: batting.stolenBases,
    total_bases: batting.totalBases,
    hits_runs_rbis:
      (batting.hits || 0) + (batting.runs || 0) + (batting.rbi || 0),

    // Pitching props
    outs_recorded: pitching.outs,
    strikeouts_pitching: pitching.strikeOuts,
    walks_allowed: pitching.baseOnBalls,
    earned_runs: pitching.earnedRuns,
    hits_allowed: pitching.hits,
  };

  return statMap[propType] ?? null;
}
