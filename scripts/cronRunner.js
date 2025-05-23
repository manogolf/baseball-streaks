import "dotenv/config";
import cron from "node-cron";
import { yesterdayET } from "../src/scripts/shared/timeUtils.js";
import { updatePropStatuses } from "../src/scripts/resolution/updatePropResults.js";
import { syncStatsForDate } from "../src/scripts/resolution/syncPlayerStats.js";
import path from "path";
import fs from "fs";
import { downloadModelFromSupabase } from "../src/scripts/shared/downloadModelFromSupabase.js"; // 🔄 Corrected relative path

console.log("⏳ Cron runner starting...");

const modelDir = "./models";
const modelFiles = [
  "hits_model.pkl",
  "runs_scored_model.pkl",
  "total_bases_model.pkl",
  // Add other model filenames as needed
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

// 🔁 Ensure models are present
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
    await ensureModelsExist(); // ✅ Models before anything else
    await syncStatsForDate(yesterdayET());
    console.log(`🚀 ${label}: Running updatePropStatuses...`);
    await updatePropStatuses();
    console.log(`✅ ${label}: Job complete.`);
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
    console.log("✅ Cron job complete.\n");
  });
}
