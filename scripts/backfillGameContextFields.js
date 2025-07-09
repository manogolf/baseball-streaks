// scripts/backfillGameContextFields.js
// ⚠️ DEPRECATED WARNING:
// This script was previously stripped down to focus only on `opponent_encoded` for debugging.
// It is now restored to populate ALL of the following fields:
// - opponent
// - opponent_encoded
// - opponent_team_id
// - home_away
// - is_home
// - game_time
// - game_day_of_week
// - time_of_day_bucket

import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
} from "../backend/scripts/shared/timeUtils.js";
import { getGameContextFields } from "../backend/scripts/shared/mlbApiUtils.js";
import { getTeamInfoByAbbr } from "../backend/scripts/shared/teamNameMap.js";

const BATCH_SIZE = 100;
const CONCURRENCY = 1;

async function fetchNextBatch() {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("id, game_id, game_date, team, is_home")
    .or(
      "game_time.is.null,time_of_day_bucket.is.null,game_day_of_week.is.null,is_home.is.null,home_away.is.null,opponent_encoded.is.null"
    )
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("❌ Failed to fetch batch:", error.message);
    return [];
  }

  console.log(`📦 Fetched ${data.length} rows needing context fields`);
  return data;
}

async function processRow(row) {
  const { id, game_id, team } = row;
  let { is_home } = row; // This is the *original* value from the DB

  console.log(`🔍 Processing row ID ${id} | team=${team} | is_home=${is_home}`);

  if (!team) {
    console.warn(`⚠️ Skipping row ${id}: missing team`);
    return;
  }

  // 🚀 Fetch *all* context fields from a single utility call
  const {
    home_away,
    opponent,
    opponent_encoded,
    opponent_team_id,
    game_time,
    game_day_of_week,
    time_of_day_bucket,
    is_home: resolvedIsHome, // ⚠️ This is the *new* computed value
  } = await getGameContextFields(game_id, team, is_home);

  // ✅ Use the resolved value instead of the stale one
  is_home = resolvedIsHome;

  const updates = {
    is_home,
    home_away,
    opponent,
    opponent_encoded,
    opponent_team_id,
    game_time,
    game_day_of_week,
    time_of_day_bucket,
  };

  const cleanedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([_, v]) => v !== undefined && v !== null)
  );

  if (Object.keys(cleanedUpdates).length > 0) {
    const { error } = await supabase
      .from("model_training_props")
      .update(cleanedUpdates)
      .eq("id", id);

    if (error) {
      console.error(`❌ Failed to update row ${id}:`, error.message);
    } else {
      console.log(`✅ Updated row ${id}`);
      console.log("🧪 Context fields applied:", cleanedUpdates);
    }
  } else {
    console.warn(`⚠️ Skipping update for ${id}: no valid fields`);
  }
}

async function runConcurrent() {
  console.log("🚀 Starting concurrent game context backfill...");

  const workers = Array(CONCURRENCY)
    .fill(null)
    .map(async (_, i) => {
      while (true) {
        console.log(`🧵 Worker ${i + 1}: fetching next batch...`);
        const batch = await fetchNextBatch();

        if (!batch.length) {
          console.log(`✅ Worker ${i + 1}: no more rows, exiting.`);
          break;
        }

        console.log(`🔧 Worker ${i + 1}: processing ${batch.length} rows...`);

        for (const row of batch) {
          try {
            await processRow(row);
          } catch (err) {
            console.error(
              `❌ Worker ${i + 1}: error in row ${row.id}:`,
              err.message
            );
          }
        }
      }
    });

  await Promise.all(workers);
  console.log("🎉 All concurrent game context backfills complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConcurrent();
}
