// ==========================================
// 📄 File: backend/scripts/generatePlayerStreakProfiles.js
// 📌 Purpose: Compute and upsert active streaks per player and prop_type
//
// 🔁 How it works:
// - Fetches resolved props (status: 'win' or 'loss') from model_training_props
// - Groups by (player_id, prop_type, prop_source)
// - Computes active "hot" or "cold" streaks
// - Upserts into player_streak_profiles with one row per (player_id, prop_type, prop_source)
//
// 🛠️ Features:
// - Fully bucketed for scalable execution over large datasets
// - Can be run safely on a cron schedule (daily or hourly)
// - Ignores unresolved or irrelevant rows (e.g., missing player_id)
// - Includes updated_at timestamp for freshness tracking
//
// 🧠 Why this matters:
// - Supports PlayerProfileDashboard streak displays
// - Feeds streak features into model training
// - Enables future streak-based alerts, filters, and prediction logic
//
// 📤 Outputs: player_streak_profiles (1 row per player + prop_type + prop_source)
//
// ✅ Dependencies:
// - model_training_props: must contain resolved props with valid outcomes
// - supabase client: defined in shared/supabaseUtils.js
// - normalizePropType: maps legacy prop names consistently
// - timeUtils.toISODate: generates UTC timestamps
//
// 🔒 Uniqueness enforced on (player_id, prop_type, prop_source)
// ==========================================

import { supabase } from "./shared/supabaseUtils.js";
import { toISODate } from "./shared/timeUtils.js";
import { normalizePropType } from "./shared/propUtils.js";

const BATCH_SIZE = 1000;
const MAX_DAYS_BACK = 90;

function computeStreaks(resolvedProps) {
  const grouped = {};

  for (const row of resolvedProps) {
    const prop_type = normalizePropType(row.prop_type);
    const { player_id, outcome, prop_source } = row;
    if (!player_id || player_id === "None") continue;

    const key = `${player_id}_${prop_type}_${prop_source}`;
    if (!grouped[key]) {
      grouped[key] = {
        player_id,
        prop_type,
        prop_source,
        streak_count: 0,
        streak_type: null,
      };
    }

    const streak = grouped[key];
    if (streak.streak_type === null) {
      streak.streak_type = outcome === "win" ? "hot" : "cold";
      streak.streak_count = 1;
    } else if (
      (streak.streak_type === "hot" && outcome === "win") ||
      (streak.streak_type === "cold" && outcome === "loss")
    ) {
      streak.streak_count += 1;
    } else {
      streak.streak_type = outcome === "win" ? "hot" : "cold";
      streak.streak_count = 1;
    }
  }

  return Object.values(grouped);
}

async function fetchResolvedProps(offset, limit, cutoffDate) {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id, prop_type, outcome, game_date, prop_source")
    .in("status", ["win", "loss"])
    .not("player_id", "is", null)
    .gte("game_date", cutoffDate)
    .order("game_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`❌ Supabase fetch error: ${error.message}`);
  }

  return data || [];
}

async function upsertStreaks(streakProfiles) {
  if (!streakProfiles.length) return;

  const enriched = streakProfiles.map((profile) => ({
    ...profile,
    updated_at: toISODate(new Date()),
  }));

  const { error } = await supabase
    .from("player_streak_profiles")
    .upsert(enriched, {
      onConflict: ["player_id", "prop_type", "prop_source"],
    });

  if (error) {
    console.error("❌ Bulk upsert failed:", error.message || error);
  } else {
    console.log(`✅ Upserted ${streakProfiles.length} streak profiles.`);
  }
}

async function main() {
  const cutoffDate = toISODate(new Date(Date.now() - MAX_DAYS_BACK * 86400000));
  let offset = 0;
  let totalProcessed = 0;
  let totalUpserted = 0;

  while (true) {
    const props = await fetchResolvedProps(offset, BATCH_SIZE, cutoffDate);
    if (!props.length) break;

    console.log(`📦 Fetched ${props.length} props from offset ${offset}`);
    const streaks = computeStreaks(props);
    await upsertStreaks(streaks);

    totalProcessed += props.length;
    totalUpserted += streaks.length;
    offset += BATCH_SIZE;

    if (props.length < BATCH_SIZE) break;
  }

  console.log(`\n📊 Total props processed: ${totalProcessed}`);
  console.log(`📥 Total streaks upserted: ${totalUpserted}`);
  console.log("🎉 Done.");
}

main();
