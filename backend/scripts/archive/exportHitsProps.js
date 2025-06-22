// scripts/exportHitsProps.js
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = 10000;
const OUTPUT_FILE = "hits_props_export.json";

async function fetchAllHitsProps() {
  let allData = [];
  let from = 0;

  console.log("📦 Starting export of 'hits' props...");

  while (true) {
    const { data, error } = await supabase
      .from("model_training_props")
      .select("*")
      .eq("prop_type", "hits")
      .not("result", "is", null)
      .range(from, from + BATCH_SIZE - 1);

    if (error) {
      console.error("❌ Supabase error:", error.message);
      break;
    }

    if (!data || data.length === 0) {
      console.log("✅ Export complete.");
      break;
    }

    allData.push(...data);
    console.log(`🔹 Fetched ${data.length} rows (Total: ${allData.length})`);

    from += BATCH_SIZE;
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allData, null, 2));
  console.log(`💾 Data saved to ${OUTPUT_FILE}`);
}

fetchAllHitsProps();
