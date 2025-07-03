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

  // Step 1: Group by player + prop + source
  for (const row of resolvedProps) {
    const prop_type = normalizePropType(row.prop_type);
    const { player_id, outcome, prop_source, game_date } = row;
    if (!player_id || player_id === "None") continue;

    const key = `${player_id}_${prop_type}_${prop_source}`;
    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push({
      outcome,
      game_date,
      player_id,
      prop_type,
      prop_source,
    });
  }

  const streakProfiles = [];

  // Step 2: For each group, sort and compute streak
  for (const groupKey in grouped) {
    const entries = grouped[groupKey];
    entries.sort((a, b) => new Date(a.game_date) - new Date(b.game_date));

    let streakType = null;
    let streakCount = 0;

    for (const entry of entries) {
      if (streakType === null) {
        streakType = entry.outcome === "win" ? "hot" : "cold";
        streakCount = 1;
      } else if (
        (streakType === "hot" && entry.outcome === "win") ||
        (streakType === "cold" && entry.outcome === "loss")
      ) {
        streakCount += 1;
      } else {
        streakType = entry.outcome === "win" ? "hot" : "cold";
        streakCount = 1;
      }
    }

    // Only one final streak per group survives
    const final = entries[entries.length - 1];
    streakProfiles.push({
      player_id: final.player_id,
      prop_type: final.prop_type,
      prop_source: final.prop_source,
      streak_type: streakType,
      streak_count: streakCount,
    });
  }

  return streakProfiles;
}

async function fetchResolvedProps(limit, beforeDate) {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id, prop_type, outcome, game_date, prop_source")
    .in("status", ["win", "loss"])
    .not("player_id", "is", null)
    .lt("game_date", beforeDate)
    .order("game_date", { ascending: false })
    .limit(limit);

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
  const MAX_DAYS_BACK = 90;
  const cutoffDate = toISODate(new Date(Date.now() - MAX_DAYS_BACK * 86400000));

  let totalProcessed = 0;
  let totalUpserted = 0;
  let lastSeenDate = toISODate(new Date()); // Start from now

  while (true) {
    const props = await fetchResolvedProps(BATCH_SIZE, lastSeenDate);
    if (!props.length) break;

    console.log(`📦 Fetched ${props.length} props before ${lastSeenDate}`);
    const streaks = computeStreaks(props);
    await upsertStreaks(streaks);

    totalProcessed += props.length;
    totalUpserted += streaks.length;

    lastSeenDate = props[props.length - 1].game_date;

    if (props.length < BATCH_SIZE || lastSeenDate < cutoffDate) break;
  }

  console.log(`\n📊 Total props processed: ${totalProcessed}`);
  console.log(`📥 Total streaks upserted: ${totalUpserted}`);
  console.log("🎉 Done.");
}

main();
