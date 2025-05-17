import "dotenv/config";
import cron from "node-cron";
import { updatePropStatuses } from "./updatePropResults.js";
import { syncStatsForDate } from "../src/scripts/resolution/syncPlayerStats.js";

console.log("⏳ Cron runner starting...");

// ✅ Determine if this is an in-season period (March to September)
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

await syncStatsForDate(); // defaults to yesterday ET

const isGitHubAction = process.env.GITHUB_ACTIONS === "true";

const safelyRun = async (label) => {
  try {
    console.log(`🚀 ${label}: Running updatePropStatuses...`);
    await updatePropStatuses();
    console.log(`✅ ${label}: Job complete.`);
    if (isGitHubAction) process.exit(0); // Required for GitHub Action to properly finish
  } catch (err) {
    console.error(`❌ ${label}: Failed with error:`, err);
    if (isGitHubAction) process.exit(1);
  }
};

// ✅ If triggered via GitHub Action, run once and exit
if (isGitHubAction) {
  safelyRun("GitHub Action");
} else {
  // ✅ Run immediately when starting locally
  safelyRun("Local run");

  // ✅ Schedule based on cron expression
  cron.schedule(cronExpression, async () => {
    const now = new Date().toISOString();
    console.log(`🕒 Cron triggered at ${now}`);
    await safelyRun("Scheduled Cron Job");
    console.log("✅ Cron job complete.\n");
  });
}
