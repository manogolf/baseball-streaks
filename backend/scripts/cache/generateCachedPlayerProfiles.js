import fetch from "node-fetch";
import { supabase } from "../shared/supabaseUtils.js";
import { getBaseURL } from "../shared/getBaseURL.js";
import "dotenv/config";

async function getAllPlayerIds() {
  const { data, error } = await supabase
    .from("player_props")
    .select("player_id")
    .not("player_id", "is", null);

  if (error) throw new Error(`❌ Failed to fetch player_ids: ${error.message}`);

  const uniqueIds = [...new Set(data.map((d) => d.player_id))];
  console.log(`📦 Found ${uniqueIds.length} unique player_ids`);
  return uniqueIds;
}

async function warmCacheForPlayer(playerId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const url = `${getBaseURL()}/player-profile/${playerId}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Status ${res.status}`);
    const json = await res.json();
    console.log(`✅ Cached profile for ${playerId}`);
    return json;
  } catch (err) {
    console.warn(`⚠️ Failed to cache profile for ${playerId}: ${err.message}`);
    return null;
  }
}

async function main() {
  try {
    console.log("🚀 Starting player profile cache generation...");
    const playerIds = await getAllPlayerIds();

    const tasks = playerIds.map((id) => warmCacheForPlayer(id));
    const results = await Promise.allSettled(tasks);

    const successCount = results.filter((r) => r.status === "fulfilled").length;
    const failedCount = results.length - successCount;

    console.log(
      `🎯 Cached ${successCount} profiles out of ${playerIds.length}`
    );
    if (failedCount > 0) {
      console.warn(`⚠️ ${failedCount} profiles failed to cache`);
    }

    process.exit(0);
  } catch (err) {
    console.error("🔥 Fatal error during cache generation:", err);
    process.exit(1);
  }
}

// ✅ Only auto-run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
