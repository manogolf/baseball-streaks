// 📄 File: scripts/repairStatDerivedProps.js

import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import { derivePropValue } from "../backend/scripts/resolution/derivePropValue.js";
import { determineOutcome } from "../backend/scripts/shared/propUtils.js";

const BATCH_SIZE = 1000;

async function fetchBrokenProps(offset = 0) {
  const { data, error } = await supabase
    .from("player_props")
    .select(
      "id, player_id, game_id, team, opponent, is_home, prop_type, line, result, prop_value, source"
    )
    .eq("source", "stat_derived")
    .or("result.is.null,prop_value.is.null")
    .order("id", { ascending: true })
    .range(offset, offset + BATCH_SIZE - 1);

  if (error) throw new Error(`❌ Failed to fetch: ${error.message}`);
  return data;
}

async function updateProps(rows) {
  const updates = [];
  for (const row of rows) {
    const value = derivePropValue(row.prop_type, row);
    if (value == null) continue;

    const outcome = determineOutcome(value, row.line);
    if (!outcome) continue;

    updates.push({ id: row.id, prop_value: value, result: outcome });
  }

  if (!updates.length) {
    console.log("⚠️ No updates to process in this batch.");
    return;
  }

  const { error } = await supabase
    .from("player_props")
    .upsert(updates, { onConflict: ["id"] });

  if (error) {
    console.error("❌ Update failed:", error.message);
  } else {
    console.log(`✅ Updated ${updates.length} broken props.`);
  }
}

async function main() {
  let offset = 0;
  let totalFixed = 0;

  while (true) {
    const batch = await fetchBrokenProps(offset);
    if (!batch.length) break;

    console.log(`🔧 Repairing batch of ${batch.length} props...`);
    await updateProps(batch);
    totalFixed += batch.length;
    offset += BATCH_SIZE;
  }

  console.log(`🎯 Repair complete. Total repaired: ${totalFixed}`);
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
});
