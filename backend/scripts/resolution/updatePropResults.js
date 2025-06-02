import "dotenv/config";
import { supabase } from "../shared/index.js";
import { todayET, yesterdayET } from "../shared/timeUtils.js";
import { expireOldPendingProps } from "../shared/propUtils.js";
import { getPendingProps } from "../shared/supabaseUtils.js";
import { getStatFromLiveFeed } from "./getStatFromLiveFeed.js";
import { extractStatForPropType } from "./statExtractors.js";
import { determineStatus } from "../shared/propUtils.js";
import fs from "fs";

export async function updatePropStatus(prop) {
  console.log(`📡 Checking prop: ${prop.player_name} - ${prop.prop_type}`);

  if (prop.prop_value < 0) {
    console.warn(`🚫 Invalid prop line value: ${prop.prop_value} — skipping`);
    return { status: "skipped", reason: "invalid line" };
  }

  let statsSource = "boxscore";
  let statBlock = null;

  // Check Supabase player_stats first
  const { data: playerStats, error: statsError } = await supabase
    .from("player_stats")
    .select("*")
    .eq("game_id", prop.game_id)
    .eq("player_id", prop.player_id)
    .maybeSingle();

  if (statsError || !playerStats) {
    console.warn(
      `⚠️ No stats found in player_stats for ${prop.player_name}, trying live feed...`
    );
    statsSource = "live";
    statBlock = await getStatFromLiveFeed(
      prop.game_id,
      prop.player_id,
      prop.prop_type
    );
  } else {
    statBlock = playerStats;
  }

  console.log("📊 Stat block keys:", Object.keys(statBlock || {}));

  // Fetch game status from MLB live feed
  let gameStatus = "Unknown";
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1.1/game/${prop.game_id}/feed/live`
    );
    const json = await res.json();
    gameStatus = json?.gameData?.status?.detailedState || "Unknown";
  } catch (err) {
    console.warn(
      `⚠️ Could not fetch game status for ${prop.game_id}: ${err.message}`
    );
  }

  // ✅ Improved DNP Check
  const relevantStat = extractStatForPropType(prop.prop_type, statBlock);

  if (
    statBlock == null ||
    relevantStat === null ||
    relevantStat === undefined
  ) {
    console.warn(
      `🚷 DNP (no relevant stat): ${prop.player_name} (${prop.prop_type})`
    );
    await supabase
      .from("player_props")
      .update({ status: "dnp" })
      .eq("id", prop.id);
    return { status: "dnp" };
  }

  // ONLY NOW: Extract the stat
  prop.result = extractStatForPropType(prop.prop_type, statBlock);
  console.log(
    `🧪 [DEBUG] Extracted result for ${prop.player_name} (${prop.prop_type}): ${prop.result}`
  );

  if (prop.result === null || prop.result === undefined) {
    console.warn(
      `⚠️ Skipped prop (${prop.player_name}, ${prop.prop_type}) — stat missing | Source: ${statsSource} | Game ID: ${prop.game_id}`
    );
    return { status: "skipped", reason: "stat not found" };
  }

  const plateApps = statBlock?.plateAppearances ?? 0;

  if (
    (relevantStat === null || relevantStat === undefined) &&
    plateApps === 0
  ) {
    console.warn(
      `🚷 DNP (no stat + 0 PA): ${prop.player_name} (${prop.prop_type})`
    );
    await supabase
      .from("player_props")
      .update({ status: "dnp" })
      .eq("id", prop.id);
    return { status: "dnp" };
  }

  // Calculate outcome
  const outcome = determineStatus(
    prop.result,
    prop.prop_value,
    prop.over_under
  );

  console.log(
    `🎯 Outcome (${statsSource}): ${prop.result} vs ${prop.prop_value} (${prop.over_under}) → ${outcome}`
  );
  // Diagnostic log BEFORE the update
  console.log(
    `🛠️ Writing to Supabase: result=${prop.result}, outcome=${outcome}, status=${outcome}, player_id=${prop.player_id}`
  );
  // Write result to Supabase
  const { error: updateError } = await supabase
    .from("player_props")
    .update({
      result: prop.result,
      outcome,
      status: outcome,
      was_correct: prop.predicted_outcome
        ? outcome === prop.predicted_outcome
        : null,
    })
    .eq("id", prop.id);

  if (updateError) {
    console.error(
      `❌ Supabase update failed for ${prop.player_name} (ID: ${prop.id}): ${updateError.message}`
    );
    return { status: "error" };
  } else {
    console.log(
      `✅ Updated prop ${prop.id} (${prop.player_name}) → ${outcome}`
    );
    return { status: "updated" };
  }
}

export async function updatePropStatuses() {
  const props = await getPendingProps();
  console.log(`🔎 Found ${props.length} pending props.`);

  let updated = 0,
    skipped = 0,
    dnps = 0,
    errors = 0;

  const skippedProps = [];

  for (const prop of props) {
    try {
      const result = await updatePropStatus(prop);
      switch (result.status) {
        case "updated":
          updated++;
          break;
        case "dnp":
          dnps++;
          break;
        case "skipped":
          skipped++;
          skippedProps.push({ ...prop, reason: result.reason });
          break;
        case "error":
          errors++;
          break;
      }
    } catch (err) {
      console.error(`🔥 Error processing ${prop.player_name}:`, err.message);
      errors++;
    }
  }

  // Save skipped props to JSON file (optional)
  if (skippedProps.length > 0) {
    fs.writeFileSync(
      "./skipped_props.json",
      JSON.stringify(skippedProps, null, 2)
    );
  }

  await expireOldPendingProps();

  console.log(
    `🏁 Update Summary → ✅ Updated: ${updated} | ⏭️ Skipped: ${skipped} | 🚷 DNP: ${dnps} | ❌ Errors: ${errors}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await updatePropStatuses();
      console.log("✅ Finished running updatePropStatuses");
    } catch (err) {
      console.error("🔥 Fatal error in updatePropStatuses:", err);
      process.exit(1);
    }
  })();
}
