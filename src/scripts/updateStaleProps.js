import { createClient } from "@supabase/supabase-js";
import { updatePropStatus } from "../../scripts/updatePropResults.js"; // Assumes this is exported
import "dotenv/config";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function reprocessOldProps() {
  const { data: oldProps, error } = await supabase
    .from("player_props")
    .select("*")
    .eq("status", "pending")
    .lt("game_date", "2025-05-02"); // ← adjust this date if needed

  if (error) {
    console.error("❌ Error fetching props:", error.message);
    return;
  }

  console.log(`🔄 Reprocessing ${oldProps.length} older pending props...`);

  let updated = 0;
  for (const prop of oldProps) {
    const ok = await updatePropStatus(prop);
    if (ok) updated++;
  }

  console.log(`✅ Reprocessed ${updated} props`);
}

reprocessOldProps();
