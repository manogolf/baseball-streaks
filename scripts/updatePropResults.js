import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  expireOldPendingProps,
  getPendingProps,
} from "../src/utils/propUtils.js";
import { getStatFromLiveFeed } from "./getStatFromLiveFeed.js";
import { nowET } from "../src/utils/timeUtils.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function determineStatus(actual, line, overUnder) {
  const direction = overUnder?.toLowerCase();
  if (actual === line) return "push";
  return (actual > line && direction === "over") ||
    (actual < line && direction === "under")
    ? "win"
    : "loss";
}

async function updatePropStatus(prop) {
  console.log(`📡 Checking prop: ${prop.player_name} - ${prop.prop_type}`);

  const { data: playerStats, error } = await supabase
    .from("player_stats") // Replace this with the correct source if needed
    .select("*")
    .eq("player_id", prop.player_id)
    .eq("game_date", prop.game_date)
    .maybeSingle();

  if (error || !playerStats) {
    console.warn(
      `⚠️ No stats found for ${prop.player_name}, trying live feed...`
    );
    const liveValue = await getStatFromLiveFeed(
      prop.game_id,
      prop.player_id,
      prop.prop_type
    );
    if (liveValue === null) return false;
    prop.result = liveValue;
  } else {
    prop.result = playerStats[prop.prop_type] ?? null;
  }

  if (prop.result === null) {
    console.warn(
      `⚠️ No stat found for ${prop.player_name} - ${prop.prop_type}`
    );
    return false;
  }

  const outcome = determineStatus(
    prop.result,
    prop.prop_value,
    prop.over_under
  );
  console.log(
    `🎯 Outcome: ${prop.result} vs ${prop.prop_value} (${prop.over_under}) → ${outcome}`
  );

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

async function updatePropStatuses() {
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

  console.log("🏁 Update Summary:");
  console.log(`✅ Updated: ${updated}`);
  console.log(`⏭️ Skipped: ${skipped}`);
  console.log(`❌ Errors: ${errors}`);
}

(async () => {
  try {
    await updatePropStatuses();
    console.log("✅ Finished running updatePropStatuses");
  } catch (err) {
    console.error("🔥 Fatal error in updatePropStatuses:", err);
    process.exit(1);
  }
})();
