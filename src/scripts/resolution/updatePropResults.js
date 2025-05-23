import "dotenv/config";
import { supabase } from "../shared/index.js";
import { todayET, yesterdayET } from "../shared/timeUtils.js";
import { expireOldPendingProps } from "../shared/propUtils.js";
import { getPendingProps } from "../shared/supabaseUtils.js";
import { getStatFromLiveFeed } from "./getStatFromLiveFeed.js";
import { extractStatForPropType } from "./statExtractors.js"; // ✅ add this at the top

function determineStatus(actual, line, overUnder) {
  const direction = overUnder?.toLowerCase();
  if (actual === line) return "push";
  return (actual > line && direction === "over") ||
    (actual < line && direction === "under")
    ? "win"
    : "loss";
}

export async function updatePropStatus(prop) {
  console.log(`📡 Checking prop: ${prop.player_name} - ${prop.prop_type}`);

  // ❌ Skip invalid props
  if (prop.prop_value < 0) {
    console.warn(`🚫 Invalid prop line value: ${prop.prop_value} — skipping`);
    return false;
  }

  let statsSource = "boxscore";
  let statBlock = null;

  // ✅ Try Supabase player_stats first
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

  // 📦 Log keys to debug unexpected nulls
  console.log("📊 Stat block keys:", Object.keys(statBlock || {}));

  // 🟡 Detect DNP — no meaningful stats
  const values = Object.values(statBlock || {});
  const meaningfulValues = values.filter((v) => v !== null && v !== undefined);
  if (meaningfulValues.length === 0) {
    console.warn(
      `⛔ Player ${prop.player_name} appears to not have played. Marking as DNP.`
    );
    await supabase
      .from("player_props")
      .update({ status: "dnp", result: null, outcome: null, was_correct: null })
      .eq("id", prop.id);
    return false;
  }

  // ✅ Extract actual result from stat block
  prop.result = extractStatForPropType(prop.prop_type, statBlock);

  if (prop.result === null || prop.result === undefined) {
    console.warn(
      `⚠️ No stat found for ${prop.player_name} - ${prop.prop_type}`
    );
    return false;
  }

  // 🎯 Calculate outcome
  const outcome = determineStatus(
    prop.result,
    prop.prop_value,
    prop.over_under
  );

  console.log(
    `🎯 Outcome (${statsSource}): ${prop.result} vs ${prop.prop_value} (${prop.over_under}) → ${outcome}`
  );

  // ✅ Write final result to Supabase
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
    console.error(`❌ Failed to update prop ${prop.id}:`, updateError.message);
    return false;
  }

  console.log(`✅ Updated prop ${prop.id} (${prop.player_name}) → ${outcome}`);
  return true;
}

export async function updatePropStatuses() {
  const props = await getPendingProps();
  console.log(`🔎 Found ${props.length} pending props.`);

  let updated = 0,
    skipped = 0,
    errors = 0;

  for (const prop of props) {
    try {
      const ok = await updatePropStatus(prop);
      ok ? updated++ : skipped++;
    } catch (err) {
      console.error(`🔥 Error processing ${prop.player_name}:`, err.message);
      errors++;
    }
  }

  await expireOldPendingProps();

  console.log(
    `🏁 Update Summary → ✅ Updated: ${updated} | ⏭️ Skipped: ${skipped} | ❌ Errors: ${errors}`
  );
}

// ✅ Ensure this only auto-runs when executed directly, NOT when imported
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
