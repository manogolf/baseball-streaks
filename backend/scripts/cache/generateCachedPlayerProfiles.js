import fetch from "node-fetch";
import { supabase } from "../../src/scripts/shared/supabaseUtils.js";
import { getBaseURL } from "../../src/scripts/shared/getBaseURL.js";
import "dotenv/config";

async function getAllPlayerIds() {
  const { data, error } = await supabase
    .from("player_props")
    .select("player_id")
    .not("player_id", "is", null);

  if (error) throw new Error(`❌ Failed to fetch player_ids: ${error.message}`);
  const uniqueIds = [...new Set(data.map((d) => d.player_id))];
  return uniqueIds;
}

async function warmCacheForPlayer(playerId) {
  try {
    const url = `${getBaseURL()}/player-profile/${playerId}`;
    const res = await fetch(url);
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
  console.log("🚀 Starting player profile cache generation...");
  const playerIds = await getAllPlayerIds();

  const tasks = playerIds.map((id) => warmCacheForPlayer(id));
  const results = await Promise.allSettled(tasks);

  const successCount = results.filter((r) => r.status === "fulfilled").length;
  console.log(`🎯 Cached ${successCount} profiles out of ${playerIds.length}`);
}

main();
