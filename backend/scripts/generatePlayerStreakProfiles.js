// 📄 File: backend/scripts/generatePlayerStreakProfiles.js

import { supabase } from "./shared/supabaseUtils.js";
import { toISODate } from "./shared/timeUtils.js";
import { normalizePropType } from "./shared/propUtils.js";

/** Fetch all resolved user- or stat-derived props with required fields */
async function fetchResolvedProps() {
  const pageSize = 10000;
  const allData = [];
  let from = 0;
  let to = pageSize - 1;

  // Extend or remove this cutoff as needed
  const cutoffDate = toISODate(new Date(Date.now() - 90 * 86400000)); // 90 days ago

  while (true) {
    const { data, error } = await supabase
      .from("model_training_props")
      .select("player_id, prop_type, outcome, game_date, prop_source")
      .in("status", ["win", "loss"])
      .not("player_id", "is", null)
      .gte("game_date", cutoffDate)
      .order("game_date", { ascending: false })
      .range(from, to);

    if (error) throw new Error(`❌ Failed to fetch props: ${error.message}`);
    if (!data || data.length === 0) break;

    allData.push(...data);
    console.log(`📦 Fetched ${allData.length} so far...`);

    if (data.length < pageSize) break;
    from += pageSize;
    to += pageSize;
  }

  return allData;
}

/** Compute per-player, per-prop_type streaks */
function computeStreaks(resolvedProps) {
  const grouped = {};
  let i = 0;

  for (const row of resolvedProps) {
    if (i % 1000 === 0) {
      console.log(`⏳ Processed ${i} of ${resolvedProps.length} props...`);
    }
    i++;

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

/** Upsert streak profiles into Supabase */
async function upsertStreaks(streakProfiles) {
  if (!streakProfiles.length) {
    //console.warn("⚠️ No streak profiles to upsert.");
    return;
  }

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

/** Main execution entry */
async function main() {
  try {
    const resolvedProps = await fetchResolvedProps();
    console.log(`🔍 Found ${resolvedProps.length} resolved props.`);

    const streakProfiles = computeStreaks(resolvedProps);
    await upsertStreaks(streakProfiles);

    console.log("🎉 Done.");
  } catch (err) {
    console.error("❌ Failed to generate streaks:", err.message);
  }
}

main();
