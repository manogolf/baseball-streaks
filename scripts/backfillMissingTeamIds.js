// scripts/backfillMissingTeamIds.js

import { supabase } from "../backend/scripts/shared/supabaseBackend.js";
import { getTeamIdFromAbbr } from "../shared/teamNameMap.js";

async function backfillMissingTeamIds() {
  console.log("🔍 Finding props missing team_id...");

  const { data: rows, error } = await supabase
    .from("model_training_props")
    .select("id, team, player_name, game_date")
    .is("team_id", null)
    .not("team", "is", null)
    .limit(5000);

  if (error) {
    console.error("❌ Error fetching rows:", error);
    return;
  }

  console.log(`🛠 Found ${rows.length} rows to update...`);

  for (const row of rows) {
    const { id, team, player_name, game_date } = row;
    const teamId = getTeamIdFromAbbr(team);

    if (!teamId) {
      console.warn(`⚠️ ${id}: No team_id for team abbr '${team}'`);
      continue;
    }

    const { error: updateError } = await supabase
      .from("model_training_props")
      .update({ team_id: teamId })
      .eq("id", id);

    if (updateError) {
      console.error(`❌ Failed to update ${id}:`, updateError);
    } else {
      console.log(
        `✅ Updated ${id} (${player_name} on ${game_date}) → team_id = ${teamId}`
      );
    }
  }

  console.log("🎯 Done updating team_id values.");
}

backfillMissingTeamIds();
