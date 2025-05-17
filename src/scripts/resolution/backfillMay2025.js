import "dotenv/config";
import { exec } from "child_process";
import { promisify } from "util";
import { DateTime } from "luxon";

const execAsync = promisify(exec);

// 📅 Set your date range here
const start = DateTime.fromISO("2025-05-01");
const end = DateTime.fromISO("2025-05-31");

async function runCommand(label, command) {
  try {
    console.log(`\n🔧 Running ${label} → ${command}`);
    const { stdout, stderr } = await execAsync(command);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
    return true;
  } catch (err) {
    console.error(`❌ Failed ${label}:`, err.message);
    return false;
  }
}

async function backfillMay() {
  for (let date = start; date <= end; date = date.plus({ days: 1 })) {
    const dateStr = date.toISODate();

    console.log(`\n📅 ===== ${dateStr} =====`);

    const synced = await runCommand(
      "syncPlayerStats",
      `node src/scripts/resolution/syncPlayerStats.js ${dateStr}`
    );

    if (!synced) {
      console.warn(
        `⚠️ Skipping prop update for ${dateStr} due to sync failure`
      );
      continue;
    }

    await runCommand(
      "updatePropResults",
      `node src/scripts/resolution/updatePropResults.js --date ${dateStr}`
    );
  }

  console.log("\n✅ Finished backfill of May 2025");
}

backfillMay();
