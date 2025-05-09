import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { todayET, currentTimeET } from "../src/utils/timeUtils.js";

// ✅ Supabase Client Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ✅ Main Sync Function
export async function syncTrainingData() {
  const { data: resolvedProps, error } = await supabase
    .from("player_props")
    .select("*")
    .eq("status", "resolved");

  if (error) {
    console.error("❌ Failed to fetch resolved props:", error.message);
    return;
  }

  for (const prop of resolvedProps) {
    const upsertData = {
      id: prop.id,
      game_date: prop.game_date,
      player_name: prop.player_name,
      team: prop.team,
      position: prop.position,
      prop_type: prop.prop_type,
      prop_value: prop.prop_value,
      result: prop.result,
      outcome: prop.outcome,
      is_pitcher: prop.is_pitcher,
      streak_count: prop.streak_count,
      over_under: prop.over_under,
      status: prop.status,
      game_id: prop.game_id,
      opponent: prop.opponent,
      home_away: prop.home_away,
      game_time: prop.game_time,
      player_id: prop.player_id,
      // ✅ New Fields for Evaluation Tracking
      predicted_outcome: prop.predicted_outcome || null,
      confidence_score: prop.confidence_score || null,
      prediction_timestamp: prop.prediction_timestamp || null,
      was_correct: prop.was_correct || null,
      prop_source: prop.prop_source || "user-added", // Defaults to user-added if not specified
    };
  }

  const { error: upsertError } = await supabase
    .from("model_training_props")
    .upsert(upsertData, { onConflict: ["id"] });

  if (upsertError) {
    console.error(`❌ Failed to upsert prop ${prop.id}:`, upsertError.message);
  } else {
    console.log(`✅ Synced prop ${prop.id} to model_training_props`);
  }
}

// ✅ Safe top-level execution block
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await syncTrainingData();
      console.log("✅ Finished running syncTrainingData");
    } catch (err) {
      console.error("🔥 Top-level error caught in syncTrainingData.js:", err);
      process.exit(1); // important for CI
    }
  })();
}
