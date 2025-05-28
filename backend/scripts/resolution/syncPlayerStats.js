// File: src/scripts/resolution/syncPlayerStats.js

import "dotenv/config";
import { supabase } from "../shared/index.js";
import { yesterdayET, toISODate } from "../shared/timeUtils.js";
import fetch from "node-fetch";

const BASE_URL = "https://statsapi.mlb.com/api/v1";

async function fetchCompletedGames(date) {
  const url = `${BASE_URL}/schedule?sportId=1&date=${date}`;
  const res = await fetch(url);
  const json = await res.json();

  const games = json.dates?.[0]?.games || [];
  return games
    .filter((g) => g.status.detailedState === "Final")
    .map((g) => g.gamePk);
}

async function fetchBoxscore(gameId) {
  const url = `${BASE_URL}/game/${gameId}/boxscore`;
  const res = await fetch(url);
  return await res.json();
}

function extractPlayerStats(player) {
  const b = player.stats?.batting || {};
  const p = player.stats?.pitching || {};

  return {
    hits: b.hits,
    total_bases: b.totalBases,
    rbis: b.rbi,
    runs: b.runs,
    strikeouts_batting: b.strikeOuts,
    walks: b.baseOnBalls,
    singles: b.singles,
    doubles: b.doubles,
    triples: b.triples,
    home_runs: b.homeRuns,
    stolen_bases: b.stolenBases,

    strikeouts_pitching: p.strikeOuts,
    walks_allowed: p.baseOnBalls,
    hits_allowed: p.hits,
    outs_recorded: p.outs,
    earned_runs: p.earnedRuns,
  };
}

// ✅ EXPORTED FUNCTION — critical for cronRunner.js
export async function syncStatsForDate(dateStr) {
  const gameIds = await fetchCompletedGames(dateStr);
  console.log(`📅 ${dateStr} → Found ${gameIds.length} final games`);

  const gameDate = toISODate(dateStr);

  for (const gameId of gameIds) {
    const boxscore = await fetchBoxscore(gameId);

    for (const side of ["home", "away"]) {
      const team = boxscore.teams?.[side]?.team?.abbreviation;
      const opponent =
        boxscore.teams?.[side === "home" ? "away" : "home"]?.team?.abbreviation;
      const players = boxscore.teams?.[side]?.players || {};

      for (const key of Object.keys(players)) {
        const player = players[key];
        const stats = extractPlayerStats(player);
        const playerId = player.person?.id?.toString();

        if (!playerId || !player.stats) {
          console.warn(
            `⏭️ Skipping ${player.person?.fullName || "Unknown"} – no stats`
          );
          continue;
        }

        const insertRow = {
          player_id: playerId,
          game_id: gameId,
          game_date: gameDate,
          team,
          opponent,
          is_home: side === "home",
          position: player.position?.abbreviation,
          ...stats,
        };

        const { error } = await supabase
          .from("player_stats")
          .upsert(insertRow, { onConflict: "player_id,game_id" });

        if (error) {
          console.error(
            `❌ Failed to insert for ${player.person.fullName}:`,
            error.message
          );
        } else {
          console.log(`✅ Saved ${player.person.fullName} (${playerId})`);
        }
      }
    }
  }
}
