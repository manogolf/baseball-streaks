import dotenv from "dotenv";
dotenv.config(); // 👈 Explicitly load the .env file
console.log("🧪 Loaded URL:", process.env.SUPABASE_URL);
import { createClient } from "@supabase/supabase-js";
import { getStatFromLiveFeed } from "./getStatFromLiveFeed.js";
import { todayET, currentTimeET } from "../utils/timeUtils.js";
// Cleanup function: expire stale pending props (older than 2 days)
async function expireOldPendingProps() {
  const twoDaysAgo = DateTime.now()
    .setZone("America/New_York")
    .minus({ days: 2 })
    .toISODate();

  const { data, error } = await supabase
    .from("player_props")
    .delete()
    .eq("status", "pending")
    .lt("game_date", twoDaysAgo);

  if (error) {
    console.error("⚠️ Failed to delete old pending props:", error.message);
  } else {
    const deletedCount = data?.length || 0;
    console.log(
      `🧹 Deleted ${deletedCount} stale pending props (older than ${twoDaysAgo})`
    );
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const nowET = DateTime.now().setZone("America/New_York");
const today = nowET.toISODate(); // '2025-05-03'
const currentTime = nowET.toFormat("HH:mm"); // '16:25' for example
const currentTimeFormatted = currentTime; // or just use currentTime directly

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";

function normalizeName(name) {
  return name.toLowerCase().replace(",", "").replace(/\./g, "").trim();
}

function findPlayerId(boxscore, targetName) {
  const players = boxscore?.teams?.home?.players || {};
  const awayPlayers = boxscore?.teams?.away?.players || {};
  const allPlayers = { ...players, ...awayPlayers };
  const normalizedTarget = normalizeName(targetName);

  for (const [id, info] of Object.entries(allPlayers)) {
    const name = normalizeName(info?.person?.fullName || "");
    console.log("🔍 Trying match:", name, "vs", normalizedTarget);

    if (name === normalizedTarget) {
      console.log("✅ Exact match found:", name);
      return id.replace("ID", "");
    }
  }

  console.warn(`❌ No exact match for ${targetName}`);
  return null;
}

function determineStatus(actual, line, overUnder) {
  const direction = overUnder?.toLowerCase(); // normalize casing
  if (actual === line) return "push";
  return (actual > line && direction === "over") ||
    (actual < line && direction === "under")
    ? "win"
    : "loss";
}

function getStatFromBoxscore(boxscore, playerId, propType) {
  // Normalize propType casing/format
  const normalizedType = propType.toLowerCase().replace(/[\s_()]/g, "");
  const stats = boxscore?.players?.[`ID${playerId}`]?.stats;
  if (!stats) {
    console.warn(`⚠️ No stats found for player ID: ${playerId}`);
    return null;
  }

  const batting = stats.batting || {};
  const pitching = stats.pitching || {};
  const singles =
    (batting.hits ?? 0) -
    (batting.doubles ?? 0) -
    (batting.triples ?? 0) -
    (batting.homeRuns ?? 0);
  const outsRecorded = pitching?.inningsPitched
    ? Math.floor(parseFloat(pitching.inningsPitched) * 3)
    : 0;
  console.log("🔍 Normalized propType:", normalizedType);

  switch (normalizedType) {
    case "hits":
      return batting.hits ?? 0;
    case "strikeouts":
    case "strikeouts(pitching)":
      return pitching.strikeOuts ?? 0;
    case "homeruns":
      return batting.homeRuns ?? 0;
    case "walks":
      return batting.baseOnBalls ?? 0;
    case "totalbases":
      return (
        singles * 1 +
        (batting.doubles ?? 0) * 2 +
        (batting.triples ?? 0) * 3 +
        (batting.homeRuns ?? 0) * 4
      );
    case "hits+runs+rbi":
    case "hitsrunsrbis":
      return (batting.hits ?? 0) + (batting.runs ?? 0) + (batting.rbi ?? 0);
    case "runsscored":
      return batting.runs ?? 0;
    case "doubles":
      return batting.doubles ?? 0;
    case "singles":
      return singles;
    case "rbis":
      return batting.rbi ?? 0;
    case "stolenbases":
      return batting.stolenBases ?? 0;
    case "hitsallowed":
      return pitching.hits ?? 0;
    case "walksallowed":
      return pitching.baseOnBalls ?? 0;
    case "strikeouts(batting)":
      return batting.strikeOuts ?? 0;
    case "outsrecorded":
      return outsRecorded;
    case "runsrbis":
    case "runs+rbi":
      return (batting.runs ?? 0) + (batting.rbi ?? 0);
    case "triples":
      return batting.triples ?? 0;
    default:
      console.warn(`⚠️ Unknown propType: ${propType} → ${normalizedType}`);
      return null;
  }
}

export async function updatePropStatus(prop) {
  console.log(`📡 Fetching boxscore for game ${prop.game_id}`);

  const url = `${MLB_API_BASE}/game/${prop.game_id}/boxscore`;
  console.log("🌐 Fetching URL:", url);

  const res = await fetch(url);
  const json = await res.json();

  const playerId = findPlayerId(json, prop.player_name);
  console.log(`🆔 Found player ID for ${prop.player_name}:`, playerId);
  const matchedName =
    json.teams.home.players?.[`ID${playerId}`]?.person?.fullName ||
    json.teams.away.players?.[`ID${playerId}`]?.person?.fullName;

  console.log(`🧾 Matched boxscore name for ID ${playerId}:`, matchedName);

  if (!playerId) {
    console.warn(
      `⚠️ Player not found: ${prop.player_name} (likely didn't play)`
    );
    return false;
  }

  let actualValue = getStatFromBoxscore(json, playerId, prop.prop_type);
  console.log(`📊 Boxscore value for ${prop.prop_type}:`, actualValue);

  if (actualValue === null) {
    console.warn(
      `⚠️ No stat found in boxscore for ${prop.prop_type} on ${prop.player_name}, trying live feed...`
    );
    actualValue = await getStatFromLiveFeed(
      prop.game_id,
      playerId,
      prop.prop_type
    );
    console.log(`📊 Live feed value for ${prop.prop_type}:`, actualValue);
  }

  if (actualValue === null) {
    console.warn(
      `⚠️ No stat found (boxscore + live) for ${prop.prop_type} on ${prop.player_name}`
    );
    return false;
  }

  const outcome = determineStatus(
    actualValue,
    prop.prop_value,
    prop.over_under
  );
  console.log(
    `🎯 Outcome determined: ${actualValue} vs line ${prop.prop_value} (${prop.over_under}) → ${outcome}`
  );

  const { error } = await supabase
    .from("player_props")
    .update({
      result: actualValue,
      outcome,
      status: outcome, // ✅ Set final status as "win", "loss", or "push"
      was_correct: prop.predicted_outcome
        ? outcome === prop.predicted_outcome
        : null,
    })
    .eq("id", prop.id);

  if (error) {
    console.error(`❌ Failed to update prop ${prop.id}:`, error.message);
    return false;
  } else {
    console.log(
      `✅ ${prop.player_name} (${prop.prop_type}): ${actualValue} → ${outcome}`
    );
    return true;
  }
}
async function getPendingProps() {
  const { data, error } = await supabase
    .from("player_props")
    .select("*")
    .eq("status", "pending")
    .or(
      `game_date.lt.${today},and(game_date.eq.${today},game_time.lte.${currentTime}),and(game_date.eq.${today},game_time.is.null)`
    )
    .order("game_date", { ascending: false })
    .order("game_time", { ascending: false });

  if (error) throw error;

  const filtered = data.filter((prop) => {
    return (
      prop.game_date < today ||
      (prop.game_date === today && prop.game_time <= currentTime)
    );
  });

  console.log(`📅 Today ET: ${today} @ ${currentTime}`);
  console.log("📊 First pending prop after filtering:", filtered?.[0]);

  return filtered;
}

export async function updatePropStatuses() {
  const props = await getPendingProps();
  console.log(`🔎 Found ${props.length} pending props to update.`);

  let updated = 0,
    skipped = 0,
    errors = 0;
  for (const prop of props) {
    try {
      const ok = await updatePropStatus(prop);
      if (ok) updated++;
      else skipped++;
    } catch (e) {
      console.error(`🔥 Error on ${prop.player_name}:`, e.message);
      errors++;
    }
  }

  await expireOldPendingProps();

  console.log("🏁 Finished processing pending props:");
  console.log(`✅ Updated: ${updated}`);
  console.log(`⏭️ Skipped: ${skipped}`);
  console.log(`❌ Errors: ${errors}`);
}

(async () => {
  try {
    await updatePropStatuses();
    console.log("✅ Finished running updatePropStatuses");
  } catch (err) {
    console.error("🔥 Top-level error caught in updatePropResults.js:", err);
  }
})();
