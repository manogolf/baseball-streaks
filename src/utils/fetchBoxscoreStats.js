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
  console.log(`📡 Fetching boxscore for game ${gamePk}`);
  const res = await fetch(url);

  if (!res.ok) {
    console.error(`❌ Failed to fetch boxscore for game ${gamePk}`);
    return null;
  }

  const json = await res.json();
  console.log(
    `📦 Parsed boxscore for game ${game_id || "(unknown ID)"}
     • Home team: ${json.teams?.home?.team?.abbreviation || "?"}, Players: ${
      Object.keys(json.teams?.home?.players || {}).length
    }
     • Away team: ${json.teams?.away?.team?.abbreviation || "?"}, Players: ${
      Object.keys(json.teams?.away?.players || {}).length
    }`
  );

  const players = [];

  for (const side of ["home", "away"]) {
    const playerMap = json.teams?.[side]?.players || {};
    for (const key in playerMap) {
      const player = playerMap[key];
      const flattened = flattenPlayerBoxscore(player);
      const id = player.person?.id;
      const name = player.person?.fullName;
      const batting = player.stats?.batting;
      const pitching = player.stats?.pitching;

      console.log(`🔍 Found player: ${name} (${id})`);
      console.log(`   • Team: ${json.teams[side]?.team?.abbreviation || "?"}`);
      console.log(`   • Is Home: ${side === "home"}`);
      console.log(
        `   • Has Batting: ${!!batting}, Has Pitching: ${!!pitching}`
      );
      console.log(`   • Flattened Stats:`, flattened);

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

  // 📍 Log number of players found and game ID
  console.log(
    `📦 Final player count from boxscore → ${players.length} (Game ID: ${gamePk})`
  );

  return players;
}

export async function getPlayerStatsFromBoxscore({ game_id, player_id }) {
  const url = `https://statsapi.mlb.com/api/v1/game/${game_id}/boxscore`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const { teams } = data;

    if (!teams?.home?.players || !teams?.away?.players) {
      return null;
    }

    const allPlayers = [
      ...Object.values(teams.home.players),
      ...Object.values(teams.away.players),
    ];

    const playerMatch = allPlayers.find(
      (p) => String(p.person?.id) === String(player_id)
    );

    if (!playerMatch) {
      return null;
    }

    const stats = playerMatch.stats || {};
    const batting = stats.batting ?? null;
    const pitching = stats.pitching ?? null;

    if (!batting && !pitching) {
      return null;
    }

    const merged = { ...batting, ...pitching };
    return merged;
  } catch (err) {
    return null;
  }
}
