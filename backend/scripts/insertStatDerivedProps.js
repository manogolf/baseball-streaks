import { supabase } from "../../src/scripts/shared/supabaseUtils.js";
import fetch from "node-fetch";
import "dotenv/config";
import { yesterdayET } from "../../src/scripts/shared/timeUtils.js";
import { propExtractors } from "../../src/scripts/shared/propUtils.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MLB_API_URL = "https://statsapi.mlb.com/api/v1";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function fetchFinalizedGames() {
  const targetDate = process.argv[2] || yesterdayET();
  console.log(`📅 Fetching finalized games for: ${targetDate}`);

  const response = await fetch(
    `${MLB_API_URL}/schedule?sportId=1&date=${targetDate}`
  );
  if (!response.ok)
    throw new Error(`MLB API failed with status ${response.status}`);

  const data = await response.json();
  const dates = data.dates || [];
  const games = dates.flatMap((d) => d.games || []);

  const finalizedGames = games
    .filter((game) => game.status.detailedState === "Final")
    .map((game) => game.gamePk);

  console.log(`📂 Found ${finalizedGames.length} finalized games.`);

  return finalizedGames;
}

async function fetchPlayerStats(gameId) {
  const response = await fetch(`${MLB_API_URL}/game/${gameId}/boxscore`);
  if (!response.ok) return null;
  const data = await response.json();
  return data.teams
    ? { home: data.teams.home.players, away: data.teams.away.players }
    : null;
}

async function processGame(gameId) {
  const players = await fetchPlayerStats(gameId);
  if (!players) return;

  for (const teamSide of ["home", "away"]) {
    const teamPlayers = players[teamSide];
    for (const playerKey in teamPlayers) {
      const playerData = teamPlayers[playerKey];
      const stats = playerData.stats?.batting || {};

      for (const [propType, extractor] of Object.entries(propExtractors)) {
        const value = extractor(stats);
        if (value === undefined || value === null) continue; // Smart OR skip

        const insertPayload = {
          id: crypto.randomUUID(),
          player_name: playerData.person.fullName,
          team: playerData.parentTeamId,
          position: playerData.position?.abbreviation || null,
          prop_type: propType,
          prop_value: null, // Stat-derived has no original line
          result: value,
          outcome: null,
          is_pitcher: false, // Add logic for pitchers later if needed
          game_date: null, // Available if you want to add date parsing
          game_id: gameId,
          over_under: null,
          source: "stat-derived",
          player_id: playerData.person.id,
          rolling_result_avg_7: null,
          hit_streak: null,
          win_streak: null,
        };

        const { error } = await supabase
          .from("model_training_props")
          .upsert(insertPayload, { onConflict: "id" });

        if (error) {
          console.warn(
            `⚠️ Failed to insert prop for ${playerData.person.fullName}: ${error.message}`
          );
        } else {
          console.log(
            `✅ Inserted stat-derived prop for ${playerData.person.fullName} (${propType})`
          );
        }
      }
    }
  }
}

async function main() {
  try {
    console.log("🚀 Starting stat-derived prop generation...");
    const gameIds = await fetchFinalizedGames();

    for (const gameId of gameIds) {
      await processGame(gameId);
    }

    console.log("🎉 Stat-derived prop generation complete!");
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
  }
}

main();
