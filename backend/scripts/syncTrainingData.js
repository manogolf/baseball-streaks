import { supabase } from "../../src/scripts/shared/supabaseUtils.js";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Always use service role key for backend scripts

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "❌ Supabase environment variables are not loaded correctly."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }, // Required for Node.js environment in Supabase v2.x
});

async function syncTrainingData() {
  try {
    console.log("🚀 Starting training data sync...");

    const { data: resolvedProps, error } = await supabase
      .from("player_props")
      .select("*")
      .eq("status", "resolved");

    if (error)
      throw new Error(`Error fetching resolved props: ${error.message}`);

    for (const prop of resolvedProps) {
      const insertPayload = {
        id: prop.id,
        player_name: prop.player_name,
        team: prop.team,
        position: prop.position,
        prop_type: prop.prop_type,
        prop_value: prop.prop_value,
        result: prop.result,
        outcome: prop.outcome,
        is_pitcher: prop.is_pitcher,
        game_date: prop.game_date,
        game_id: prop.game_id,
        over_under: prop.over_under,
        source: "user-added",
        player_id: prop.player_id ?? null,
        rolling_result_avg_7: prop.rolling_result_avg_7 ?? null,
        hit_streak: prop.hit_streak ?? null,
        win_streak: prop.win_streak ?? null,
      };

      const { error: insertError } = await supabase
        .from("model_training_props")
        .upsert(insertPayload, { onConflict: "id" });

      if (insertError) {
        console.warn(
          `⚠️ Failed to upsert prop ID ${prop.id}: ${insertError.message}`
        );
      } else {
        console.log(`✅ Synced prop ID ${prop.id}`);
      }
    }

    console.log("🎉 Training data sync complete!");
  } catch (err) {
    console.error(`❌ Sync failed: ${err.message}`);
  }
}

syncTrainingData();
