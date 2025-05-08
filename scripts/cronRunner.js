import "dotenv/config";
import cron from "node-cron";
import { updatePropStatuses } from "./updatePropResults.js";
import { syncTrainingData } from "./syncTrainingData.js";
import { syncStreakProfiles } from "./syncStreakProfiles.js";

export const updateAndSyncProps = async () => {
  console.log("🔄 Running update and sync logic...");

  try {
    await updatePropStatuses();
    await syncTrainingData();
    await syncStreakProfiles();
    console.log("✅ Update + Sync complete");
  } catch (err) {
    console.error("🔥 Error during update/sync:", err.message);
    throw err; // rethrow so outer wrapper catches it
  }
};

console.log("⏳ Cron job starting...");

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

const safelyRun = async (label) => {
  try {
    console.log(`🚀 ${label}: running updateAndSyncProps...`);
    await updateAndSyncProps();
    console.log(`✅ ${label}: job complete. Exiting...`);
    if (isGitHubAction) process.exit(0);
  } catch (err) {
    console.error(`❌ ${label}: failed with error:`, err);
    if (isGitHubAction) process.exit(1);
  }
};

if (isGitHubAction) {
  safelyRun("GitHub Action");
} else {
  safelyRun("Local run");

  cron.schedule(cronExpression, async () => {
    const now = new Date().toISOString();
    console.log(`🕒 Cron triggered at ${now}`);
    await safelyRun("Cron job");
    console.log("✅ Cron job complete.\n");
  });
}
