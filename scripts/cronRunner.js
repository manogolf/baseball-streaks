import "dotenv/config";
import cron from "node-cron";
import path from "path";
import fs from "fs";
import { yesterdayET } from "../backend/scripts/shared/timeUtils.js";
import { updatePropStatuses } from "../backend/scripts/resolution/updatePropResults.js";
//import { syncStatsForDate } from "../backend/scripts/resolution/syncPlayerStats.js";
import { downloadModelFromSupabase } from "../backend/scripts/shared/downloadModelFromSupabase.js";
import { runTrainingBackfillIfNeeded } from "./backfillTrainingFieldsExtended.js";

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
    await ensureModelsExist();
    //await syncStatsForDate(yesterdayET());
    console.log(`🚀 ${label}: Running updatePropStatuses...`);
    await updatePropStatuses(); // Already logs summary internally
    console.log(`📊 ${label}: Running conditional training backfill...`);
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
