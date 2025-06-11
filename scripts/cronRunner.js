import "dotenv/config";
import cron from "node-cron";
import path from "path";
import fs from "fs";
import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import { yesterdayET } from "../backend/scripts/shared/timeUtils.js";
import { updatePropStatusesForRows } from "../backend/scripts/resolution/updatePropResults.js";
import { syncStatsForDate } from "../backend/scripts/resolution/syncPlayerStats.js";
import { downloadModelFromSupabase } from "../backend/scripts/shared/downloadModelFromSupabase.js";
import { runTrainingBackfillIfNeeded } from "./backfillTrainingFieldsExtended.js";

console.log("⏳ Cron runner starting...");

const { data: propsToRetry, error } = await supabase
  .from("player_props")
  .select("*")
  .eq("status", "pending") // or any custom logic
  .limit(500);

if (error) {
  console.error("❌ Failed to fetch props:", error.message);
} else {
  await updatePropStatusesForRows(propsToRetry);
}

const modelDir = "./models";
const modelFiles = [
  "hits_model.pkl",
  "runs_scored_model.pkl",
  "total_bases_model.pkl",
  "rbis_model.pkl",
  "walks_model.pkl",
  "strikeouts_batting_model.pkl",
  "strikeouts_pitching_model.pkl",
  "walks_allowed_model.pkl",
  "hits_allowed_model.pkl",
  "home_runs_model.pkl",
  "doubles_model.pkl",
  "triples_model.pkl",
  "singles_model.pkl",
  "stolen_bases_model.pkl",
  "runs_rbis_model.pkl",
  "hits_runs_rbis_model.pkl",
];

const month = new Date().getUTCMonth();
const inSeason = month >= 2 && month <= 9;
const cronExpression = inSeason ? "*/30 * * * *" : "0 10 * * *";

console.log(
  `📅 Scheduling cron job: ${
    inSeason
      ? "every 30 minutes (in-season)"
      : "daily at 10:00 UTC (off-season)"
  }`
);

const isGitHubAction = process.env.GITHUB_ACTIONS === "true";

async function ensureModelsExist() {
  for (const filename of modelFiles) {
    const modelPath = path.join(modelDir, filename);
    if (!fs.existsSync(modelPath)) {
      console.log(`⬇️  Downloading ${filename} from Supabase...`);
      try {
        await downloadModelFromSupabase(filename, modelPath);
        console.log(`✅ Downloaded ${filename}`);
      } catch (err) {
        console.error(`❌ Error downloading ${filename}: ${err.message}`);
      }
    } else {
      console.log(`📦 ${filename} already exists.`);
    }
  }
}

const safelyRun = async (label) => {
  try {
    console.log(`🔁 ${label}: Starting scheduled tasks...`);

    // 🧠 Step 1: Ensure models exist
    await ensureModelsExist();

    // 📅 Step 2: Sync stats (if enabled)
    await syncStatsForDate(yesterdayET());

    // 📊 Step 3: Update prop statuses (limited batch)
    const { data: propsToRetry, error } = await supabase
      .from("player_props")
      .select("*")
      .eq("status", "pending")
      .limit(500);

    if (error) {
      console.error(`❌ Failed to fetch pending props: ${error.message}`);
    } else if (propsToRetry?.length) {
      console.log(
        `🔧 Updating ${propsToRetry.length} props via batch resolution...`
      );
      await updatePropStatusesForRows(propsToRetry);
    } else {
      console.log("✅ No pending props to update.");
    }

    // 📈 Step 4: Backfill training (if needed)
    await runTrainingBackfillIfNeeded();

    console.log(`✅ ${label}: All tasks complete.\n`);

    if (isGitHubAction) process.exit(0);
  } catch (err) {
    console.error(`❌ ${label}: Failed with error:`, err);
    if (isGitHubAction) process.exit(1);
  }
};

if (isGitHubAction) {
  await safelyRun("GitHub Action");
} else {
  await safelyRun("Local run");
  cron.schedule(cronExpression, async () => {
    const now = new Date().toISOString();
    console.log(`🕒 Cron triggered at ${now}`);
    await safelyRun("Scheduled Cron Job");
  });
}
