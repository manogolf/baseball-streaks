// fetchBoxscoreStats.js

import fetch from "node-fetch";

// 🧠 Flatten and normalize boxscore player stats
export function flattenPlayerBoxscore(player) {
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

// 🔍 Fetch entire boxscore and flatten all players
export async function fetchBoxscoreStatsForGame(gamePk) {
  const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
  console.log(`📡 Fetching boxscore for game ${gamePk}`);

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();

    const players = [];

    for (const side of ["home", "away"]) {
      const team = json.teams?.[side];
      const playerMap = team?.players || {};

      for (const key in playerMap) {
        const player = playerMap[key];
        const flattened = flattenPlayerBoxscore(player);
        const id = player.person?.id;
        const name = player.person?.fullName;

        if (id) {
          players.push({
            id,
            fullName: name,
            teamAbbr: team?.team?.abbreviation,
            isHome: side === "home",
            stats: flattened,
          });
        }
      }
    }

    console.log(`📦 Parsed ${players.length} players from game ${gamePk}`);
    return players;
  } catch (err) {
    console.error(
      `❌ Failed to fetch boxscore for game ${gamePk}:`,
      err.message
    );
    return null;
  }
}

// 🎯 Get a single player's raw stats object from the boxscore
export async function getPlayerStatsFromBoxscore({ game_id, player_id }) {
  const url = `https://statsapi.mlb.com/api/v1/game/${game_id}/boxscore`;
  console.log(`📡 Fetching boxscore for game ${game_id}`);
  console.log(`🆔 Looking for player ID: ${player_id}`);

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const allPlayers = {
      ...json.teams?.home?.players,
      ...json.teams?.away?.players,
    };

    const match = Object.values(allPlayers).find(
      (p) => String(p.person?.id) === String(player_id)
    );

    if (!match) {
      console.warn(`🚫 Player ${player_id} not found in boxscore`);
      return null;
    }

    const stats = match.stats || {};
    if (!stats.batting && !stats.pitching) {
      console.warn(`📭 No relevant stats in boxscore for ${player_id}`);
      return null;
    }

    const merged = { ...stats.batting, ...stats.pitching };
    console.log(`🧪 Merged raw stats for ${player_id}:`, merged);
    return merged;
  } catch (err) {
    console.error(`❌ Error during boxscore fetch:`, err.message);
    return null;
  }
}
