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
  console.log(`📡 Fetching boxscore for game ${game_id}`);
  console.log(`🆔 Looking for player ID: ${player_id}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`❌ Failed to fetch boxscore: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const allPlayers = {
      ...data.teams?.home?.players,
      ...data.teams?.away?.players,
    };

    const allPlayerEntries = Object.entries(allPlayers);
    const idsInBoxscore = allPlayerEntries
      .map(([key, val]) => val?.person?.id)
      .filter(Boolean);
    console.log("📋 All player IDs in boxscore:", idsInBoxscore);
    console.log("🧩 Total players found:", idsInBoxscore.length);
    console.log(`🔎 Searching for player_id: ${player_id}`);

    const match = Object.values(allPlayers).find(
      (p) => String(p.person?.id) === String(player_id)
    );

    if (!match) {
      console.warn(`🚫 Player ${player_id} not found in boxscore`);
      console.warn(
        "🧨 Available player keys in boxscore:",
        Object.keys(allPlayers)
      );
      console.warn("🧾 Sample player object:", Object.values(allPlayers)[0]);
      return null;
    }

    console.log(`👤 Matched player ${player_id}`);
    console.log("📂 match.stats:", match.stats);

    const stats = match.stats || {};
    if (!stats || (!stats.batting && !stats.pitching)) {
      console.warn(`📭 No relevant stats found in boxscore for ${player_id}`);
      return null;
    }

    const merged = { ...stats.batting, ...stats.pitching };
    console.log(`🧪 Final merged stats for ${player_id}:`, merged);
    return merged;
  } catch (err) {
    console.error("❌ Error during fetch:", err.message);
    return null;
  }
}
