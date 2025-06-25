// File: scripts/generateDerivedStats.js

import { supabase } from "./shared/supabaseUtils.js";
import { toISODate } from "./shared/timeUtils.js";
import { getDerivedStats } from "./shared/getDerivedStats.js";

/**
 * Fetch distinct players who have had props recently (last 30 days)
 */
async function fetchRecentPlayers(days = 30) {
  const cutoffDate = toISODate(new Date(Date.now() - days * 86400000));

  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id", { distinct: true })
    .gte("game_date", cutoffDate);

  if (error) throw new Error(`❌ Failed to fetch players: ${error.message}`);
  return data.map((row) => row.player_id);
}

/**
 * Calculate d7/d15/d30 stats for a player by pulling past game logs
 */
async function calculateDerivedStatsForPlayer(player_id, game_date) {
  const windows = [7, 15, 30];
  const result = {};

  for (const window of windows) {
    const stats = await getDerivedStats(player_id, window);
    if (!stats) continue;

    const prefix = `d${window}`;
    result[`${prefix}_hits`] = stats.hits;
    result[`${prefix}_homeRuns`] = stats.homeRuns;
    result[`${prefix}_rbi`] = stats.rbi;
    result[`${prefix}_strikeOuts`] = stats.strikeOuts;
    result[`${prefix}_baseOnBalls`] = stats.baseOnBalls;
  }

  return result;
}

/**
 * Upsert to a new table like `player_derived_stats` (schema: player_id, stat_type, value, updated_at)
 */
async function upsertDerivedStats(player_id, game_id, game_date, statsObj) {
  const enriched = {
    player_id,
    game_id, // ✅ required column
    game_date, // ✅ critical line to fix the null error
    ...statsObj,
    updated_at: toISODate(new Date()),
  };

  const { error } = await supabase
    .from("player_derived_stats")
    .upsert(enriched, { onConflict: ["player_id", "game_id", "game_date"] });

  if (error)
    console.error(`❌ Failed to upsert stats for ${player_id}:`, error.message);
  else console.log(`✅ Upserted derived stats for ${player_id}`);
}

/** Main */
async function main() {
  const players = await fetchRecentPlayers();
  console.log(`🔍 Found ${players.length} recent players to process`);

  for (const player_id of players) {
    const { data: recentGames, error } = await supabase
      .from("model_training_props")
      .select("game_id, game_date")
      .eq("player_id", player_id)
      .order("game_date", { ascending: false })
      .limit(1);

    if (error || !recentGames?.length) {
      console.warn(`⚠️ No recent game found for ${player_id}`);
      continue;
    }

    const { game_id, game_date } = recentGames[0];

    const stats = await calculateDerivedStatsForPlayer(player_id, game_date);
    if (Object.keys(stats).length === 0) continue;

    await upsertDerivedStats(player_id, game_id, game_date, stats);
  }

  console.log("🎉 Finished generating derived stats.");
}

main();
