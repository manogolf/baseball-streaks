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

export async function runExtendedBackfill() {
  const { data: rows, error } = await supabase
    .from("model_training_props")
    .select("*")
    .or(
      "rolling_result_avg_7.is.null,hit_streak.is.null,win_streak.is.null,game_time.is.null,is_home.is.null,opponent.is.null,prop_value.is.null,over_under.is.null"
    );

  if (error) {
    console.error("❌ Error fetching rows:", error.message);
    return;
  }

  if (!rows || rows.length === 0) {
    console.log("🎉 No incomplete training rows found.");
    return;
  }

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.player_id]) grouped[row.player_id] = [];
    grouped[row.player_id].push(row);
  }

  const playerIds = Object.keys(grouped);

  // 🔢 Bucket filtering logic
  const filteredPlayerIds = playerIds.filter(
    (_, index) => index % totalBuckets === currentBucket
  );

  console.log(
    `🧩 Bucket ${currentBucket + 1}/${totalBuckets} → ${
      filteredPlayerIds.length
    } players`
  );

  let updated = 0,
    failed = 0;

  const skippedByProp = {}; // Track skipped rows by prop_type

  // 🔁 Loop through each player in this bucket
  for (let i = 0; i < filteredPlayerIds.length; i++) {
    const player_id = filteredPlayerIds[i];
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
            row.game_date
          );
          if (avg != null) updates.rolling_result_avg_7 = avg;
        }

        if (row.hit_streak == null || row.win_streak == null) {
          const streaks = await getStreaksForPlayer(
            row.player_id,
            row.prop_type
          );
          if (!streaks) {
            skippedByProp[row.prop_type] =
              (skippedByProp[row.prop_type] || 0) + 1;
            continue;
          }
          if (row.hit_streak == null) updates.hit_streak = streaks.hit_streak;
          if (row.win_streak == null) updates.win_streak = streaks.win_streak;
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
          row.source === "stat_derived"
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
if (process.argv[1].includes("backfillTrainingFieldsExtended.js")) {
  await runTrainingBackfillIfNeeded();
}
