// src/utils/fetchBoxscoreStats.js
import fetch from "node-fetch";

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
      const stats = player?.stats?.batting;
      if (!stats) continue;

      players.push({
        id: player.person?.id,
        fullName: player.person?.fullName,
        teamAbbr: json.teams[side]?.team?.abbreviation,
        stats,
        isHome: side === "home",
      });
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

  return {
    ...match.stats,
  };
}
