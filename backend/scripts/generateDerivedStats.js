// 📄 File: backend/scripts/generateDerivedStats.js

import { supabase } from "./shared/supabaseUtils.js";
import { getDerivedStats } from "./shared/getDerivedStats.js";
import { toISODate } from "./shared/timeUtils.js";

// Config
const LOOKBACK_DAYS = 2;
const TOTAL_BUCKETS = 8;

// Get CLI bucket arg: --bucket=1/8
const bucketArg = process.argv.find((arg) => arg.startsWith("--bucket="));
const [currentBucket, totalBuckets] = bucketArg
  ? bucketArg.replace("--bucket=", "").split("/").map(Number)
  : [null, null];

/**
 * Fetch unique (player_id, game_date, game_id) combos to backfill
 */
async function getRecentPlayerGames() {
  const cutoffDate = toISODate(new Date(Date.now() - LOOKBACK_DAYS * 86400000));

  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id, game_date, game_id")
    .gte("game_date", cutoffDate)
    .not("player_id", "is", null)
    .order("game_date", { ascending: true });

  if (error)
    throw new Error("❌ Failed to fetch recent games: " + error.message);

  const seen = new Set();
  const uniqueRows = data.filter((row) => {
    const key = `${row.player_id}_${row.game_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return uniqueRows;
}

async function updateDerivedStats(rows) {
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const { player_id, game_date, game_id } = rows[i];
    console.log(
      `⏳ (${i + 1}/${rows.length}) Player ${player_id} on ${game_date}`
    );

    try {
      const derivedStats = await getDerivedStats(player_id, game_date);
      const isEmpty =
        Object.keys(derivedStats).length === 0 ||
        Object.values(derivedStats).every((v) => v == null);

      if (isEmpty) {
        console.log(`🟡 Skipped: No usable stats`);
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

      if (!error) {
        updated++;
      } else {
        console.warn(`❌ Supabase error: ${error.message}`);
      }
    } catch (err) {
      console.warn(
        `⚠️ Failed for player ${player_id} on ${game_date}: ${err.message}`
      );
    }
  }

  console.log(`\n✅ Bucket complete: ${updated} updated, ${skipped} skipped`);
}

// Main execution entry point
async function run() {
  const allRows = await getRecentPlayerGames();
  console.log(`📦 Total unique (player_id, game_date): ${allRows.length}`);

  if (currentBucket && totalBuckets) {
    // Run single bucket
    const bucketSize = Math.ceil(allRows.length / totalBuckets);
    const start = (currentBucket - 1) * bucketSize;
    const end = currentBucket * bucketSize;
    const bucketRows = allRows.slice(start, end);

    console.log(
      `🔢 Running bucket ${currentBucket}/${totalBuckets} [${start} → ${end}]`
    );
    await updateDerivedStats(bucketRows);
  } else {
    // Run all buckets sequentially
    for (let i = 1; i <= TOTAL_BUCKETS; i++) {
      const bucketSize = Math.ceil(allRows.length / TOTAL_BUCKETS);
      const start = (i - 1) * bucketSize;
      const end = i * bucketSize;
      const bucketRows = allRows.slice(start, end);

      console.log(
        `\n⏳ Starting bucket ${i}/${TOTAL_BUCKETS} [${start} → ${end}]...\n`
      );
      await updateDerivedStats(bucketRows);
    }

    console.log(`\n🎉 All ${TOTAL_BUCKETS} buckets processed.`);
  }
}

run();
