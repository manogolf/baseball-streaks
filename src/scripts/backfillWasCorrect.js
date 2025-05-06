import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function backfillWasCorrect() {
  console.log("🔍 Fetching resolved props missing `was_correct`...");

  const { data, error } = await supabase
    .from("player_props")
    .select("id, predicted_outcome, outcome, status")
    .is("was_correct", null)
    .in("status", ["win", "loss"])
    .not("predicted_outcome", "is", null);

  if (error) {
    console.error("❌ Failed to fetch props:", error.message);
    return;
  }

  console.log(`📦 Found ${data.length} props to backfill...`);

  const updates = data.map((row) => ({
    id: row.id,
    was_correct:
      row.outcome === "push" ? null : row.predicted_outcome === row.outcome,
  }));

  for (const row of updates) {
    const { error: updateError } = await supabase
      .from("player_props")
      .update({ was_correct: row.was_correct })
      .eq("id", row.id);

    if (updateError) {
      console.error(`❌ Failed to update prop ${row.id}:`, updateError.message);
    } else {
      console.log(`✅ Backfilled was_correct for prop ${row.id}`);
    }
  }

  console.log("🏁 Backfill complete.");
}

backfillWasCorrect();
