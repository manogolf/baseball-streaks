// 📄 File: scripts/generatePlayerStreakProfiles.js

import { supabase } from "../scripts/shared/supabaseUtils.js";
import { normalizePropType } from "../scripts/shared/propUtils.js";
import { toISODate } from "../scripts/shared/timeUtils.js";

// 🧩 Optional bucketed support
const [_, bucketArg] =
  process.argv.find((arg) => arg.includes("--bucket"))?.split("=") || [];
let currentBucket = 0,
  totalBuckets = 1;

if (bucketArg && bucketArg.includes("/")) {
  const [curr, total] = bucketArg.split("/").map((n) => parseInt(n));
  currentBucket = curr - 1;
  totalBuckets = total;
}

console.log(
  `📦 Running streak profile generator (Bucket ${
    currentBucket + 1
  }/${totalBuckets})`
);

async function fetchResolvedProps() {
  const pageSize = 10000;
  const allData = [];
  let from = 0;
  let to = pageSize - 1;

  const cutoffDate = toISODate(new Date(Date.now() - 14 * 86400000)); // ⏳ 14 days ago

  while (true) {
    const { data, error } = await supabase
      .from("player_props")
      .select("player_id, prop_type, outcome, game_date")
      .in("status", ["win", "loss"])
      .not("player_id", "is", null)
      .gte("game_date", cutoffDate) // ✅ Limit to last 14 days
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

function computeStreaks(resolvedProps) {
  const grouped = {};
  let i = 0;

  for (const row of resolvedProps) {
    if (i % 1000 === 0) {
      console.log(`⏳ Processed ${i} of ${resolvedProps.length} props...`);
    }
    i++;

    const prop_type = normalizePropType(row.prop_type);
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
      streak.streak_type = outcome === "win" ? "hot" : "cold";
      streak.streak_count = 1;
    }
  }

  return Object.values(grouped);
}

async function upsertStreaks(streakProfiles) {
  if (!streakProfiles.length) {
    console.warn("⚠️ No streak profiles to upsert.");
    return;
  }

  const enriched = streakProfiles.map((profile) => ({
    ...profile,
    updated_at: toISODate(new Date()),
  }));

  const { error } = await supabase
    .from("player_streak_profiles")
    .upsert(enriched, {
      onConflict: ["player_id", "prop_type"],
    });

  if (error) {
    console.error("❌ Bulk upsert failed:", error.message || error);
  } else {
    console.log(`✅ Upserted ${streakProfiles.length} streak profiles.`);
  }
}

async function main() {
  try {
    const resolvedProps = await fetchResolvedProps();
    console.log(`🔍 Found ${resolvedProps.length} resolved props.`);

    const allKeys = [
      ...new Set(
        resolvedProps.map(
          (r) => `${r.player_id}_${normalizePropType(r.prop_type)}`
        )
      ),
    ];
    const filteredKeys = allKeys.filter(
      (_, idx) => idx % totalBuckets === currentBucket
    );
    const keySet = new Set(filteredKeys);
    const filteredProps = resolvedProps.filter((r) =>
      keySet.has(`${r.player_id}_${normalizePropType(r.prop_type)}`)
    );

    console.log(`🎯 Bucketed resolved props → ${filteredProps.length}`);

    const streakProfiles = computeStreaks(filteredProps);
    await upsertStreaks(streakProfiles);
    console.log("🎉 Done.");
  } catch (err) {
    console.error("❌ Failed to generate streaks:", err.message);
  }
}

main();
