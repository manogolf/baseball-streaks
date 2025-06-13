// 📄 File: scripts/cron-runner.js

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
import { copyUserAddedPropsToTraining } from "./shared/modelTrainingUtils.js";

console.log("⏳ Cron runner starting...");

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
const isGitHubAction = process.env.GITHUB_ACTIONS === "true";

console.log(
  `📅 Scheduling cron job: ${
    inSeason
      ? "every 30 minutes (in-season)"
      : "daily at 10:00 UTC (off-season)"
  }`
);

// 🔧 Download any missing model files
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

await copyUserAddedPropsToTraining(7); // sync last 7 days

// 🧠 Run one full cycle of tasks
const safelyRun = async (label) => {
  try {
    console.log(`🔁 ${label}: Starting scheduled tasks...`);

    await ensureModelsExist();

    // Step 1: Sync stats
    console.log("📊 Syncing stats for yesterday...");
    await syncStatsForDate(yesterdayET());
    console.log("✅ Stats sync complete.");

    // Step 2: Update pending props
    const { data: pendingProps, error } = await supabase
      .from("player_props")
      .select("*")
      .eq("status", "pending")
      .limit(500);

    if (error) {
      console.error(`❌ Failed to fetch pending props: ${error.message}`);
    } else if (pendingProps.length) {
      console.log(`🔧 Resolving ${pendingProps.length} pending props...`);
      await updatePropStatusesForRows(pendingProps);
      console.log("✅ Prop resolution complete.");
    } else {
      console.log("✅ No pending props to resolve.");
    }

    // Step 3: Backfill training fields
    console.log("📥 Checking for training backfill needs...");
    const ranBackfill = await runTrainingBackfillIfNeeded();
    console.log(
      ranBackfill
        ? "✅ Training backfill completed."
        : "✅ No training rows needed backfill."
    );

    console.log(`✅ ${label}: All tasks complete.\n`);
    if (isGitHubAction) process.exit(0);
  } catch (err) {
    console.error(`❌ ${label}: Failed with error:`, err);
    if (isGitHubAction) process.exit(1);
  }
};

// Run once immediately
await safelyRun(isGitHubAction ? "GitHub Action" : "Local run");

// Schedule repeated execution if not in GitHub Actions
if (!isGitHubAction) {
  cron.schedule(cronExpression, async () => {
    const now = new Date().toISOString();
    console.log(`🕒 Cron triggered at ${now}`);
    await safelyRun("Scheduled Cron Job");
  });
}
