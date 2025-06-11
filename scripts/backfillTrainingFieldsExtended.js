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
  let totalUpdated = 0;
  let batchCount = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from("model_training_props")
      .select("*")
      .or(
        "rolling_result_avg_7.is.null,hit_streak.is.null,win_streak.is.null,game_time.is.null,is_home.is.null,opponent.is.null,prop_value.is.null,over_under.is.null"
      )
      .limit(BATCH_SIZE);

    if (error) {
      console.error("❌ Error fetching rows:", error.message);
      break;
    }

    if (!rows || rows.length === 0) {
      console.log("🎉 No more incomplete rows. Exiting loop.");
      break;
    }

    console.log(`🔁 Processing batch ${++batchCount}, rows: ${rows.length}`);
    let updated = 0;

    for (const row of rows) {
      if (isTrainingRowComplete(row)) {
        continue;
      }

      const updates = {};

      // Rolling average
      if (row.rolling_result_avg_7 == null) {
        const avg = await getRollingAverage(
          row.player_id,
          row.prop_type,
          row.game_date
        );
        if (avg != null) updates.rolling_result_avg_7 = avg;
      }

      // Streaks — skip row entirely if streaks are required but unavailable
      if (row.hit_streak == null || row.win_streak == null) {
        const streaks = await getStreaksForPlayer(row.player_id, row.prop_type);
        if (!streaks) {
          console.warn(
            `⚠️ No streak profile found for ${row.player_id} (${row.prop_type}), skipping row.`
          );
          continue;
        }
        if (row.hit_streak == null) updates.hit_streak = streaks.hit_streak;
        if (row.win_streak == null) updates.win_streak = streaks.win_streak;
      }

      // Game time
      if (row.game_time == null && row.game_id) {
        const gameTime = await getGameTimeFromID(row.game_id);
        if (gameTime) updates.game_time = gameTime;
      }

      // Home/Away status
      if (row.is_home == null && row.team && row.game_id) {
        const isHome = await determineHomeAway(row.team, row.game_id);
        if (typeof isHome === "boolean") updates.is_home = isHome;
      }

      // Opponent team
      if (row.opponent == null && row.team && row.game_id) {
        const opponent = await determineOpponent(row.team, row.game_id);
        if (opponent) updates.opponent = opponent;
      }

      // Prop value
      if (
        row.prop_value == null &&
        row.result != null &&
        row.source === "stat_derived"
      ) {
        updates.prop_value = parseFloat(row.result);
      }

      // Over/Under fallback
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
          console.warn("⚠️ Failed to update row:", row.id, updateError.message);
        } else {
          updated++;
        }
      }
    }

    console.log(`✅ Batch ${batchCount} complete: ${updated} rows updated`);
    totalUpdated += updated;

    if (updated === 0) {
      console.log(
        "🛑 No rows updated this batch. Assuming remaining rows are incomplete permanently. Exiting."
      );
      break;
    }

    await new Promise((res) => setTimeout(res, 200)); // slight delay
  }

  console.log(`🏁 Backfill finished. Total updated: ${totalUpdated}`);
}

// Allow CLI usage
if (process.argv[1].includes("backfillTrainingFieldsExtended.js")) {
  await runTrainingBackfillIfNeeded();
}
