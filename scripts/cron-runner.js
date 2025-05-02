import "dotenv/config";
import { updatePropStatuses } from "./updatePropResults.js";
import { syncTrainingData } from "./syncTrainingData.js";

console.log("⏳ Starting cron-runner.js...");

async function run() {
  try {
    console.log("🔄 Updating prop statuses...");
    await updatePropStatuses();

    console.log("📚 Syncing training data...");
    await syncTrainingData();

    console.log("✅ Cron tasks completed successfully.");
  } catch (err) {
    console.error("❌ Cron runner error:", err);
    process.exit(1);
  }
}

run();
