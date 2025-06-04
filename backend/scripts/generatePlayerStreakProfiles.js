import { supabase } from "./shared/supabaseUtils.js";
import { normalizePropType } from "./shared/propUtils.js";
import { toISODate } from "./shared/timeUtils.js";
import crypto from "node:crypto";

// 📥 Fetch resolved props
async function fetchResolvedProps() {
  const { data, error } = await supabase
    .from("player_props")
    .select("player_id, prop_type, outcome, game_date")
    .in("status", ["win", "loss"])
    .not("player_id", "is", null);

  if (error)
    throw new Error(`Failed to fetch resolved props: ${error.message}`);
  return data;
}

// 🧠 Compute streaks from sorted props
function computeStreaks(resolvedProps) {
  const grouped = {};

  for (const row of resolvedProps) {
    const rawPropType = row.prop_type;
    const prop_type = normalizePropType(rawPropType);
    const { player_id, outcome } = row;

    if (!player_id || player_id === "None") continue;

    const key = `${player_id}_${prop_type}`;
    if (!grouped[key]) {
      grouped[key] = {
        player_id,
        prop_type,
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
      // Streak broke — reset
      streak.streak_type = outcome === "win" ? "hot" : "cold";
      streak.streak_count = 1;
    }
  }

  return Object.values(grouped);
}

// ⬆️ Upsert into Supabase
async function upsertStreaks(streakProfiles) {
  let inserted = 0;
  for (const profile of streakProfiles) {
    const { player_id, prop_type, streak_count, streak_type } = profile;

    if (!player_id || player_id === "None" || !prop_type) continue;

    const { error } = await supabase.from("player_streak_profiles").upsert(
      {
        player_id,
        prop_type,
        streak_count,
        streak_type,
        updated_at: toISODate(new Date()),
      },
      { onConflict: ["player_id", "prop_type"] }
    );

    if (error) {
      console.warn(
        `⚠️ Failed upsert for ${player_id} (${prop_type}): ${error.message}`
      );
    } else {
      inserted += 1;
    }
  }

  console.log(`✅ Upserted ${inserted} streak profiles.`);
}

async function main() {
  try {
    console.log("📥 Fetching resolved props...");
    const resolvedProps = await fetchResolvedProps();
    console.log(`🔍 Found ${resolvedProps.length} resolved props.`);

    console.log("🧠 Analyzing streaks...");
    const streakProfiles = computeStreaks(resolvedProps);

    console.log(`⬆️ Attempting to upsert ${streakProfiles.length} profiles...`);
    await upsertStreaks(streakProfiles);

    console.log("🎉 Done.");
  } catch (err) {
    console.error("❌ Failed to generate streak profiles:", err.message);
  }
}

main();
