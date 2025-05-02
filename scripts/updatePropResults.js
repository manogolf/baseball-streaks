import "dotenv/config";
import cron from "node-cron";
import { updatePropStatuses } from "./updatePropResults.js";
import { syncTrainingData } from "./syncTrainingData.js";

export const updateAndSyncProps = async () => {
  console.log("🔄 Running update and sync logic...");

  try {
    await updatePropStatuses();
    await syncTrainingData();
    console.log("✅ Update + Sync complete");
  } catch (err) {
    console.error("🔥 Error during update/sync:", err.message);
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

if (isGitHubAction) {
  (async () => {
    console.log("🚀 GitHub Action: running updateAndSyncProps...");
    await updateAndSyncProps();
    console.log("✅ GitHub Action: job complete. Exiting...");
    process.exit(0);
  })();
} else {
  (async () => {
    console.log("🚀 Local run: updateAndSyncProps...");
    await updateAndSyncProps();
  })();

  cron.schedule(cronExpression, async () => {
    const now = new Date().toISOString();
    console.log(`🕒 Cron triggered at ${now}`);
    await updateAndSyncProps();
    console.log("✅ Cron job complete.\n");
  });
}
