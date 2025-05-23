import fetch from "node-fetch";

// 🧠 Flatten boxscore player stats
function flattenPlayerBoxscore(player) {
  const batting = player.stats?.batting || {};
  const pitching = player.stats?.pitching || {};

  return {
    hits: batting.hits ?? null,
    runs: batting.runs ?? null,
    rbis: batting.rbi ?? null,
    doubles: batting.doubles ?? null,
    triples: batting.triples ?? null,
    home_runs: batting.homeRuns ?? null,
    walks: batting.baseOnBalls ?? null,
    strikeouts_batting: batting.strikeOuts ?? null,
    stolen_bases: batting.stolenBases ?? null,
    total_bases: batting.totalBases ?? null,

    outs_recorded: pitching.outs ?? null,
    strikeouts_pitching: pitching.strikeOuts ?? null,
    walks_allowed: pitching.baseOnBalls ?? null,
    earned_runs: pitching.earnedRuns ?? null,
    hits_allowed: pitching.hits ?? null,
  };
}

export async function fetchBoxscoreStatsForGame(gamePk) {
  const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`❌ Failed to fetch boxscore for game ${gamePk}`);
    return null;
  }

  const json = await res.json();
  const players = [];

  for (const side of ["home", "away"]) {
    const playerMap = json.teams?.[side]?.players || {};
    for (const key in playerMap) {
      const player = playerMap[key];
      const flattened = flattenPlayerBoxscore(player);
      const id = player.person?.id;

      if (id) {
        players.push({
          id,
          fullName: player.person?.fullName,
          teamAbbr: json.teams[side]?.team?.abbreviation,
          isHome: side === "home",
          stats: flattened,
        });
      }
    }
  }

  return players;
}

export async function getPlayerStatsFromBoxscore(gamePk, playerId) {
  const allPlayers = await fetchBoxscoreStatsForGame(gamePk);
  if (!allPlayers) return null;

  const match = allPlayers.find((p) => String(p.id) === String(playerId));
  if (!match) {
    console.warn(
      `⚠️ Player ID ${playerId} not found in boxscore for game ${gamePk}`
    );
    return null;
  }

  return match.stats;
}
