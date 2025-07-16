// scripts/backfillGameContextFields.js

import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import { getGameContextFields } from "../backend/scripts/shared/mlbApiUtils.js";

const BATCH_SIZE = 100;
const CONCURRENCY = 1;

let updateCount = 0;
let skipCount = 0;

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

  return data;
}

async function processRow(row) {
  const { id, game_id, team } = row;
  let { is_home } = row;

  if (!team) {
    console.warn(`⚠️ Skipping row ${id}: missing team`);
    skipCount++;
    return;
  }

  const {
    home_away,
    opponent,
    opponent_encoded,
    game_time,
    game_day_of_week,
    time_of_day_bucket,
    is_home: resolvedIsHome,
  } = await getGameContextFields(game_id, team, is_home);

  is_home = resolvedIsHome;

  const updates = {
    is_home,
    home_away,
    opponent,
    opponent_encoded,
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
      updateCount++;
    }
  } else {
    skipCount++;
  }
}

export async function runConcurrent() {
  console.log("🚀 Starting game context backfill...");

  const workers = Array(CONCURRENCY)
    .fill(null)
    .map(async (_, i) => {
      while (true) {
        const batch = await fetchNextBatch();

        if (!batch.length) {
          break;
        }

        for (const row of batch) {
          try {
            await processRow(row);
          } catch (err) {
            console.error(`❌ Error in row ${row.id}:`, err.message);
          }
        }
      }
    });

  await Promise.all(workers);

  console.log("🎉 Game context backfill complete.");
  console.log(`📈 Rows updated: ${updateCount}`);
  console.log(`⏭️ Rows skipped: ${skipCount}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConcurrent();
}
