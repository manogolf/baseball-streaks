// scripts/repairStatDerivedProps.js

import { supabase } from "../../backend/scripts/shared/supabaseUtils.js";
import {
  flattenPlayerBoxscore,
  didPlayerParticipate,
} from "../../backend/scripts/shared/playerUtils.js";
import { getBoxscoreFromGameID } from "../../backend/scripts/shared/mlbApiUtils.js";
import {
  extractStatForPropType,
  determineOutcome,
} from "../../backend/scripts/shared/propUtils.js";
import fs from "fs";

const SKIPPED_LOG = "skippedRepairs.log";

function logSkip(id, reason) {
  const message = `⏭ Skipping row ID ${id}: ${reason}`;
  console.warn(message);
  fs.appendFileSync(SKIPPED_LOG, message + "\n");
}

async function fetchBrokenProps() {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("id, player_id, game_id, prop_type, prop_value, over_under")
    .eq("prop_source", "mlb_api")
    .in("status", ["win", "loss"])
    .is("result", null)
    .range(0, 4999); // Up to 5000 rows

  if (error) throw new Error("❌ Failed to fetch: " + error.message);
  return data;
}

async function repairPropRow(row) {
  const { id, player_id, game_id, prop_type, prop_value, over_under } = row;

  if (!player_id || !game_id || !prop_type) {
    logSkip(id, "Missing player_id, game_id, or prop_type");
    return null;
  }

  const boxscore = await getBoxscoreFromGameID(game_id);
  if (!boxscore) {
    logSkip(id, "Missing boxscore");
    return null;
  }

  const stats = flattenPlayerBoxscore(player_id, boxscore);
  if (!didPlayerParticipate(stats)) {
    logSkip(id, "Player did not participate");
    return null;
  }

  const propValue = extractStatForPropType(prop_type, stats);
  if (typeof propValue !== "number") {
    logSkip(id, "Stat not extractable");
    return null;
  }

  const status = determineOutcome(propValue, prop_value, over_under);
  if (!status || !["win", "loss", "push"].includes(status)) {
    logSkip(id, `Could not determine status: ${status}`);
    return null;
  }

  return {
    id,
    result: propValue,
    status,
    // prediction, outcome, and was_correct are skipped due to missing column
  };
}

async function main() {
  console.log("⚡ Starting repair of stat-derived props...");
  fs.writeFileSync(SKIPPED_LOG, ""); // Clear log

  const brokenRows = await fetchBrokenProps();
  console.log("🔍 Rows needing repair:", brokenRows.length);

  const repaired = [];
  for (const row of brokenRows) {
    const fixed = await repairPropRow(row);
    if (fixed) repaired.push(fixed);
  }

  if (repaired.length === 0) {
    console.log("🤷 No rows could be repaired.");
    return;
  }

  const { error } = await supabase
    .from("model_training_props")
    .upsert(repaired, { onConflict: "id" });

  if (error) {
    throw new Error("❌ Upsert failed: " + error.message);
  }

  console.log(`✅ Repaired ${repaired.length} rows successfully.`);
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
