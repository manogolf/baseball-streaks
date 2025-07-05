/**
 * 📄 File: scripts/backfillTrainingFieldsExtended.js
 *
 * 🔍 Description:
 * This script performs a comprehensive backfill of missing training features in the
 * `model_training_props` table. It is designed to fill in any null or incomplete fields
 * critical for model training, such as:
 *   - Rolling average (7-day result)
 *   - Hit/win streaks
 *   - Game time
 *   - Home/away status
 *   - Opponent
 *   - Derived prop value (if missing but result exists)
 *   - Inferred over/under (if missing but result + value exist)
 *
 * 🧱 It fetches all incomplete rows and processes them grouped by player, supporting
 * optional bucketing to parallelize large backfills.
 *
 * ✅ Triggered manually or via cron using:
 *   `node scripts/backfillTrainingFieldsExtended.js`
 *   or with buckets:
 *   `node scripts/backfillTrainingFieldsExtended.js --bucket=1/4`
 *
 * 🧩 Dependencies:
 * - Supabase DB connection
 * - Shared utilities: propUtils.js, playerUtils.js, timeUtils.js, fetchSchedule.js
 *
 * 🎯 Purpose:
 * Ensures all training rows are complete and feature-rich before being used for model
 * retraining or evaluation. Critical to maintain feature consistency across rows.
 */

import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import {
  getRollingAverage,
  determineHomeAway,
  determineOpponent,
} from "../backend/scripts/shared/propUtils.js";
import { getStreaksForPlayer } from "../backend/scripts/shared/playerUtils.js";
import { getGameTimeFromID } from "../src/utils/fetchSchedule.js";

console.log("🚀 Starting extended backfill for training fields...");

const BATCH_SIZE = 500;

// Bucket setup
const bucketArg = process.argv.find((arg) => arg.startsWith("--bucket="));
const bucketInfo = bucketArg
  ? bucketArg.replace("--bucket=", "").split("/")
  : null;

let currentBucket = 0;
let totalBuckets = 1;

if (bucketInfo && bucketInfo.length === 2) {
  currentBucket = parseInt(bucketInfo[0]) - 1;
  totalBuckets = parseInt(bucketInfo[1]);
}

function isTrainingRowComplete(row) {
  return (
    row.rolling_result_avg_7 != null &&
    row.hit_streak != null &&
    row.win_streak != null &&
    row.game_time != null &&
    row.is_home != null &&
    row.opponent != null &&
    row.prop_value != null &&
    row.over_under != null
  );
}

export async function runTrainingBackfillIfNeeded() {
  const { data } = await supabase
    .from("model_training_props")
    .select("id")
    .is("game_time", null)
    .limit(1);

  if (data.length === 0) {
    console.log("✅ Training data already complete. Skipping backfill.");
    return;
  }

  console.log("⚠️ Incomplete training rows found. Running backfill...");
  await runExtendedBackfill();
}

async function fetchAllIncompleteRowsForPlayers(playerIds) {
  const pageSize = 1000;
  let from = 0;
  let to = pageSize - 1;
  let allRows = [];

  const { data, error } = await supabase
    .from("model_training_props")
    .select("*")
    .eq("player_id", "605137")
    .eq("prop_type", "hits")
    .is("hit_streak", null)
    .order("game_date", { ascending: true });

  if (error) {
    console.error("❌ Error fetching test player rows:", error.message);
    return [];
  }

  return data;
}

export async function runExtendedBackfill() {
  const { data: allIncomplete } = await supabase
    .from("model_training_props")
    .select("player_id")
    .or(
      "rolling_result_avg_7.is.null,hit_streak.is.null,win_streak.is.null,game_time.is.null,is_home.is.null,opponent.is.null,prop_value.is.null,over_under.is.null"
    );

  if (!allIncomplete || allIncomplete.length === 0) {
    console.log("🎉 No incomplete training rows found.");
    return;
  }

  const allPlayerIds = [...new Set(allIncomplete.map((row) => row.player_id))];
  const filteredPlayerIds = allPlayerIds.filter(
    (_, index) => index % totalBuckets === currentBucket
  );

  console.log(
    `🧩 Bucket ${currentBucket + 1}/${totalBuckets} → ${
      filteredPlayerIds.length
    } players`
  );

  const rows = await fetchAllIncompleteRowsForPlayers(filteredPlayerIds);

  if (!rows || rows.length === 0) {
    console.log("🎉 No incomplete rows found in this bucket.");
    return;
  }

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.player_id]) grouped[row.player_id] = [];
    grouped[row.player_id].push(row);
  }

  let updated = 0,
    failed = 0;
  const skippedByProp = {};

  const playerIds = Object.keys(grouped);
  for (let i = 0; i < playerIds.length; i++) {
    const player_id = playerIds[i];
    const playerProps = grouped[player_id];

    console.log(
      `🔍 (${i + 1}/${filteredPlayerIds.length}) Player ${player_id} → ${
        playerProps.length
      } rows`
    );

    for (const row of playerProps) {
      if (isTrainingRowComplete(row)) continue;

      const updates = {};

      try {
        if (row.rolling_result_avg_7 == null) {
          const avg = await getRollingAverage(
            row.player_id,
            row.prop_type,
            row.game_date,
            row.game_id,
            7
          );
          if (avg != null) updates.rolling_result_avg_7 = avg;
        }

        if (row.hit_streak == null || row.win_streak == null) {
          const streaks = await getStreaksForPlayer(
            row.player_id,
            row.prop_type,
            row.prop_source || "mlb_api"
          );

          if (!streaks) {
            skippedByProp[row.prop_type] =
              (skippedByProp[row.prop_type] || 0) + 1;
            continue;
          }

          if (row.hit_streak == null) updates.hit_streak = streaks.streak_count;
          if (row.win_streak == null) updates.win_streak = streaks.streak_count;
        }

        if (row.game_time == null && row.game_id) {
          const gameTime = await getGameTimeFromID(row.game_id);
          if (gameTime) updates.game_time = gameTime;
        }

        if (row.is_home == null && row.team && row.game_id) {
          const isHome = await determineHomeAway(row.team, row.game_id);
          if (typeof isHome === "boolean") updates.is_home = isHome;
        }

        if (row.opponent == null && row.team && row.game_id) {
          const opponent = await determineOpponent(row.team, row.game_id);
          if (opponent) updates.opponent = opponent;
        }

        if (
          row.prop_value == null &&
          row.result != null &&
          row.source === "mlb_api"
        ) {
          updates.prop_value = parseFloat(row.result);
        }

        if (
          row.over_under == null &&
          row.predicted_outcome &&
          row.prop_value != null &&
          row.result != null
        ) {
          const actual = parseFloat(row.result);
          const line = parseFloat(row.prop_value);
          updates.over_under =
            actual > line ? "over" : actual < line ? "under" : "push";
        }

        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await supabase
            .from("model_training_props")
            .update(updates)
            .eq("id", row.id);

          if (updateError) {
            console.warn(
              "⚠️ Failed to update row:",
              row.id,
              updateError.message
            );
            failed++;
          } else {
            updated++;
          }
        }
      } catch (err) {
        console.error(`❌ Failed to update row ${row.id}:`, err.message);
        failed++;
      }
    }

    // Optional: report every 100 players
    if ((i + 1) % 100 === 0) {
      console.log(`⏳ Player progress: ${i + 1}/${filteredPlayerIds.length}`);
      console.log(`   → ✅ ${updated} | ❌ ${failed}`);
    }
  }

  console.log(`\n🏁 Final Backfill Summary → ✅ ${updated} | ❌ ${failed}`);

  if (Object.keys(skippedByProp).length) {
    console.log(`\n⚠️ Skipped due to missing streak profiles:`);
    Object.entries(skippedByProp)
      .sort((a, b) => b[1] - a[1])
      .forEach(([prop_type, count]) => {
        console.log(`  ${prop_type.padEnd(20)} — ${count}`);
      });
  }
}

// Allow CLI usage
if (
  process.argv[1].includes("backfillTrainingFieldsExtended.js") &&
  !process.argv.some((arg) => arg.startsWith("--bucket="))
) {
  const totalBuckets = 16;
  for (let i = 1; i <= totalBuckets; i++) {
    console.log(`\n⏳ Starting bucket ${i}/${totalBuckets}...\n`);
    process.argv.push(`--bucket=${i}/${totalBuckets}`);
    await runTrainingBackfillIfNeeded();
    process.argv.pop();
  }
} else {
  await runTrainingBackfillIfNeeded();
}
