// 📄 File: backend/scripts/generateDerivedStats.js

import { supabase } from "./shared/supabaseUtils.js";
import { getDerivedStats } from "./shared/getDerivedStats.js";
import { toISODate } from "./shared/timeUtils.js";
import { VALID_PROP_TYPES } from "./shared/propUtils.js";

// How many days to look back for newly added props
const LOOKBACK_DAYS = 30;

/**
 * Get list of distinct (player_id, game_date) combos from recent model_training_props
 * to use for computing derived stats.
 */
async function getRecentPlayerGames() {
  const cutoffDate = toISODate(new Date(Date.now() - LOOKBACK_DAYS * 86400000));

  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id, game_date, game_id, prop_type")
    .in("prop_type", VALID_PROP_TYPES)
    .gte("game_date", cutoffDate)
    .not("player_id", "is", null)
    .order("game_date", { ascending: true });

  if (error)
    throw new Error("❌ Failed to fetch recent games: " + error.message);

  const seen = new Set();
  return data.filter((row) => {
    const key = `${row.player_id}_${row.game_date}_${row.prop_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/**
 * Upserts the computed d7/d15/d30 stats into player_derived_stats for each row.
 */
async function updateDerivedStats() {
  const rows = await getRecentPlayerGames();
  console.log(
    `📊 Total distinct (player_id, game_date) combos fetched: ${rows.length}`
  );
  console.log(`🔍 Found ${rows.length} player-game combos to backfill...`);

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const { player_id, game_date, game_id } = rows[i];
    console.log(`⏳ Processing ${i + 1} of ${rows.length}`);

    try {
      const derivedStats = await getDerivedStats(player_id, game_date);
      console.log(
        `📋 Derived stats for player ${player_id} on ${game_date}:`,
        derivedStats
      );

      const allValuesEmpty =
        Object.keys(derivedStats).length === 0 ||
        Object.values(derivedStats).every((v) => v == null);

      if (allValuesEmpty) {
        console.log(
          `🟡 Skipped: No non-null derived stats for player ${player_id} on ${game_date}`
        );
        skipped++;
        continue;
      }

      const { error } = await supabase.from("player_derived_stats").upsert(
        {
          player_id,
          game_date,
          game_id,
          ...derivedStats,
        },
        { onConflict: ["player_id", "game_date"] }
      );

      if (!error) updated++;
      else console.warn(`❌ Supabase error: ${error.message}`);
    } catch (err) {
      console.warn(
        `⚠️ Failed for player ${player_id} on ${game_date}: ${err.message}`
      );
    }
  }

  console.log(`✅ Updated ${updated} rows.`);
  console.log(`🟡 Skipped ${skipped} rows with no usable stats.`);
}

updateDerivedStats();
