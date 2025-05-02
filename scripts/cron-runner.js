require("dotenv/config");
const { updatePropStatuses } = require("./updatePropResults.js");
const { syncTrainingData } = require("./syncTrainingData.js");

async function runCronTasks() {
  console.log("🔁 Starting cron tasks...");
  await updatePropStatuses();
  await syncTrainingData();
  console.log("✅ All tasks complete.");
}

runCronTasks();
