import crypto from "node:crypto";
import { supabase } from "./shared/supabaseUtils.js";
import fetch from "node-fetch";
import "dotenv/config";
import { toISODate, yesterdayET } from "./shared/timeUtils.js";
import { propExtractors, normalizePropType } from "./shared/propUtils.js";

const MLB_API_URL = "https://statsapi.mlb.com/api/v1";

async function fetchFinalizedGames(targetDate) {
  const response = await fetch(
    `${MLB_API_URL}/schedule?sportId=1&date=${targetDate}`
  );
  if (!response.ok) throw new Error(`MLB API failed: ${response.status}`);

  const data = await response.json();
  const games = (data.dates || []).flatMap((d) => d.games || []);
  return games
    .filter((g) => g.status?.detailedState === "Final")
    .map((g) => g.gamePk);
}

async function fetchPlayerStats(gameId) {
  const res = await fetch(`${MLB_API_URL}/game/${gameId}/boxscore`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.teams
    ? { home: data.teams.home.players, away: data.teams.away.players }
    : null;
}

async function processGame(gameId, gameDate) {
  const players = await fetchPlayerStats(gameId);
  if (!players) return;

  for (const side of ["home", "away"]) {
    const teamPlayers = players[side];
    for (const key in teamPlayers) {
      const player = teamPlayers[key];
      const stats = player?.stats?.batting || player?.stats?.pitching;
      if (!stats) continue;

      for (const [propType, extractor] of Object.entries(propExtractors)) {
        let value;
        try {
          value = extractor(stats);
        } catch {
          continue;
        }
        if (typeof value !== "number" || isNaN(value)) continue;

        const payload = {
          id: crypto.randomUUID(),
          player_name: player.person.fullName,
          team: player.parentTeamId?.toString() ?? null,
          position: player.position?.abbreviation || null,
          prop_type: propType,
          prop_value: null,
          result: value,
          outcome: null,
          is_pitcher: !!player.stats?.pitching,
          game_date: gameDate,
          game_id: gameId,
          over_under: null,
          source: "stat_derived",
          player_id: player.person.id.toString(),
          rolling_result_avg_7: null,
          hit_streak: null,
          win_streak: null,
        };

        const { error } = await supabase
          .from("model_training_props")
          .upsert(payload, { onConflict: "id" });

        if (error) {
          console.warn(
            `⚠️ Failed insert for ${player.person.fullName}: ${error.message}`
          );
        } else {
          console.log(
            `✅ Inserted stat-derived prop for ${player.person.fullName} (${propType})`
          );
        }
      }
    }
  }
}

function generateDateRange(start, end) {
  const dates = [];
  const current = new Date(start);
  const final = new Date(end);
  while (current <= final) {
    dates.push(toISODate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function main() {
  const defaultStart = yesterdayET(-2); // Default: 3-day range
  const startArg = process.argv[2];
  const startDate = startArg || defaultStart;
  const endDate = toISODate(new Date());

  const dateRange = generateDateRange(startDate, endDate);
  console.log(`📆 Dates to process: ${dateRange.join(", ")}`);

  try {
    for (const date of dateRange) {
      console.log(`📅 Processing finalized games for: ${date}`);
      const gameIds = await fetchFinalizedGames(date);
      for (const gameId of gameIds) {
        await processGame(gameId, date);
      }
    }
    console.log("🎉 Stat-derived prop generation complete!");
  } catch (err) {
    console.error("❌ Script failed:", err.message);
  }
}

main();
