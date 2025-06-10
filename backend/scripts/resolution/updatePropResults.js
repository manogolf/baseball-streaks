import "dotenv/config";
import fs from "fs";
import { supabase } from "../shared/index.js";
import { expireOldPendingProps, determineStatus } from "../shared/propUtils.js";
import { didPlayerParticipate } from "../shared/playerUtils.js";
import { getPendingProps } from "../shared/supabaseUtils.js";
import { resolveStatForPlayer, hasMeaningfulStats } from "./statResolvers.js";

// 📝 Append console output to log file while still printing to terminal
// ✅ Save the original console methods to avoid recursion
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
};

// ✅ Log to both file and console without recursion
function logToFileAndConsole(level = "log", ...args) {
  const method = originalConsole[level] ?? originalConsole.log;
  const timestamp = new Date().toISOString();

  const message = args
    .map((arg) =>
      typeof arg === "string" ? arg : JSON.stringify(arg, null, 2)
    )
    .join(" ");

  const logLine = `[${timestamp}] ${message}\n`;
  fs.appendFileSync("update_log.txt", logLine);
  method(...args);
}

// ✅ Override the console methods safely
console.log = (...args) => logToFileAndConsole("log", ...args);
console.error = (...args) => logToFileAndConsole("error", ...args);
console.warn = (...args) => logToFileAndConsole("warn", ...args);

const affectedPlayerIds = new Set();
const resultsLog = [];

export async function updatePropStatus(prop) {
  console.log(`📡 Checking prop: ${prop.player_name} - ${prop.prop_type}`);

  if (prop.prop_value < 0) {
    console.warn(`🚫 Invalid prop line value: ${prop.prop_value} — skipping`);
    return { status: "skipped", reason: "invalid line" };
  }

  const { result, source, rawStats } = await resolveStatForPlayer({
    player_id: prop.player_id,
    player_name: prop.player_name,
    team: prop.team,
    game_id: prop.game_id,
    prop_type: prop.prop_type,
  });

  if (!rawStats || typeof rawStats !== "object") {
    console.warn(`🚷 Marking DNP: no rawStats found for ${prop.player_name}`);
    await supabase
      .from("player_props")
      .update({ status: "dnp" })
      .eq("id", prop.id);
    return { status: "dnp", reason: "missing rawStats" };
  }

  console.log(
    `📊 Raw stats for ${prop.player_name} (${prop.prop_type}):`,
    rawStats
  );

  // ✅ ADD THIS BLOCK NEXT:
  if (typeof result !== "number" || isNaN(result)) {
    console.warn(
      `🚷 Marking DNP: result not a valid number for ${prop.player_name}`
    );
    await supabase
      .from("player_props")
      .update({ status: "dnp" })
      .eq("id", prop.id);
    return { status: "dnp", reason: "invalid result type" };
  }

  const isValid = hasMeaningfulStats(rawStats);
  const didPlay = didPlayerParticipate(rawStats);

  if (!isValid) {
    const allValues = rawStats ? Object.values(rawStats) : [];
    const allNull = allValues.length && allValues.every((v) => v === null);

    if (allNull) {
      console.warn(`🚷 Marking DNP: all stats null`);
      await supabase
        .from("player_props")
        .update({ status: "dnp" })
        .eq("id", prop.id);
      return { status: "dnp", reason: "all stats null" };
    }

    console.warn(
      `⚠️ Proceeding despite partial stats — found: ${Object.keys(
        rawStats
      ).join(", ")}`
    );
  }

  if (!didPlay) {
    console.warn(`🚷 Marking DNP: no meaningful stats`);
    await supabase
      .from("player_props")
      .update({ status: "dnp" })
      .eq("id", prop.id);
    return { status: "dnp", reason: "no participation" };
  }

  if (result == null) {
    console.warn(`🚷 Marking DNP: no result extracted`);
    await supabase
      .from("player_props")
      .update({ status: "dnp" })
      .eq("id", prop.id);
    return { status: "dnp", reason: "no result" };
  }

  prop.result = result;
  console.log(
    `🧪 Extracted result for ${prop.player_name} (${prop.prop_type}): ${prop.result}`
  );

  const outcome = determineStatus(
    prop.result,
    prop.prop_value,
    prop.over_under
  );

  const was_correct =
    prop.predicted_outcome != null ? outcome === prop.predicted_outcome : null;

  const { error: updateError } = await supabase
    .from("player_props")
    .update({
      result: prop.result,
      outcome,
      status: outcome,
      was_correct,
    })
    .eq("id", prop.id);

  if (updateError) {
    console.error(
      `❌ Supabase update failed for ${prop.player_name}:`,
      updateError.message
    );
    return { status: "error" };
  }

  affectedPlayerIds.add(prop.player_id);
  console.log(`✅ Updated prop ${prop.id} → ${outcome}`);
  return { status: "updated" };
}

export async function updatePropStatuses() {
  const props = await getPendingProps();
  console.log(`🔎 Found ${props.length} pending props.`);

  let updated = 0,
    skipped = 0,
    dnps = 0,
    errors = 0;

  const skippedProps = [];

  for (const prop of props) {
    try {
      const result = await updatePropStatus(prop);
      resultsLog.push({
        id: prop.id,
        player_name: prop.player_name,
        team: prop.team,
        prop_type: prop.prop_type,
        prop_value: prop.prop_value,
        over_under: prop.over_under,
        game_date: prop.game_date,
        game_id: prop.game_id,
        player_id: prop.player_id,
        status: result.status,
        reason: result.reason || null,
        timestamp: new Date().toISOString(),
      });

      switch (result.status) {
        case "updated":
          updated++;
          break;
        case "dnp":
          dnps++;
          break;
        case "skipped":
          skipped++;
          skippedProps.push({ ...prop, reason: result.reason });
          break;
        case "error":
          errors++;
          break;
      }
    } catch (err) {
      console.error(`🔥 Error processing ${prop.player_name}:`, err.message);
      errors++;

      // Log to JSON file for later inspection
      const errorLog = {
        id: prop.id,
        player_name: prop.player_name,
        game_date: prop.game_date,
        prop_type: prop.prop_type,
        player_id: prop.player_id,
        game_id: prop.game_id,
        error: err.message,
        timestamp: new Date().toISOString(),
      };

      const path = "./update_errors.json";
      const existing = fs.existsSync(path)
        ? JSON.parse(fs.readFileSync(path, "utf8"))
        : [];
      existing.push(errorLog);
      fs.writeFileSync(path, JSON.stringify(existing, null, 2));
    }
  }

  if (skippedProps.length > 0) {
    fs.writeFileSync(
      "./skipped_props.json",
      JSON.stringify(skippedProps, null, 2)
    );
  }

  await expireOldPendingProps();

  console.log(
    `🏁 Summary → ✅ ${updated} | ⏭️ ${skipped} | 🚷 ${dnps} | ❌ ${errors}`
  );

  const logPath = `./prop_results_log_${Date.now()}.json`;
  fs.writeFileSync(logPath, JSON.stringify(resultsLog, null, 2));
  console.log(`📝 Saved results log to ${logPath}`);

  if (affectedPlayerIds.size > 0) {
    const { error: cacheError } = await supabase
      .from("player_profiles_cache")
      .delete()
      .in("player_id", Array.from(affectedPlayerIds));

    if (cacheError) {
      console.warn("⚠️ Failed to clear player cache:", cacheError.message);
    } else {
      console.log(`🧹 Cleared cache for ${affectedPlayerIds.size} players`);
    }
  }
}

export async function updatePropStatusesForRows(props) {
  if (!Array.isArray(props) || props.length === 0) {
    console.log("⚠️ No props provided to update.");
    return;
  }

  let updated = 0,
    dnp = 0,
    skipped = 0,
    error = 0;

  for (const prop of props) {
    try {
      const result = await updatePropStatus(prop);
      switch (result.status) {
        case "updated":
          updated++;
          break;
        case "dnp":
          dnp++;
          break;
        case "skipped":
          skipped++;
          break;
        case "error":
        default:
          error++;
          break;
      }
    } catch (err) {
      console.error(`❌ Error on prop ${prop.id}:`, err.message);
      error++;
    }
  }

  console.log(
    `🏁 Custom Batch Summary → ✅ ${updated} | 🚷 ${dnp} | ⏭️ ${skipped} | ❌ ${error}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await updatePropStatuses();
      console.log("✅ Finished running updatePropStatuses");
    } catch (err) {
      console.error("🔥 Fatal error in updatePropStatuses:", err);
      process.exit(1);
    }
  })();
}
