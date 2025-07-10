// File: scripts/backfillPvBBvPStats.js

import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import { resolveStatForPlayer } from "../backend/scripts/resolution/statResolvers.js";
import fetch from "node-fetch";

const DELAY_MS = 200;

const MISSING_CONDITIONS = [
  "pvb_ab.is.null",
  "pvb_hits.is.null",
  "pvb_hr.is.null",
  "pvb_strikeouts.is.null",
  "pvb_walks.is.null",
  "bvp_ab.is.null",
  "bvp_hits.is.null",
  "bvp_hr.is.null",
  "bvp_strikeouts.is.null",
  "bvp_walks.is.null",
].join(",");

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchRowsNeedingStats(offset = 0, limit = 1000) {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("id, player_id, prop_type, game_id")
    .or(MISSING_CONDITIONS)
    .not("player_id", "is", null)
    .not("game_id", "is", null)
    .range(offset, offset + limit - 1); // fetch 1000 rows

  if (error) {
    console.error("❌ Failed to fetch rows:", error.message);
    return [];
  }

  return data;
}

async function fetchBoxscore(gameId) {
  const url = `https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json;
  } catch (err) {
    console.error(
      `❌ Failed to fetch boxscore for game ${gameId}: ${err.message}`
    );
    return null;
  }
}

function getPlayerTeamFromBoxscore(box, playerId) {
  const homePlayers = box?.teams?.home?.players || {};
  const awayPlayers = box?.teams?.away?.players || {};

  for (const player of Object.values(homePlayers)) {
    if (player?.person?.id === playerId) return "home";
  }

  for (const player of Object.values(awayPlayers)) {
    if (player?.person?.id === playerId) return "away";
  }

  return null;
}

async function processRow(row) {
  const { id, player_id, prop_type, game_id } = row;

  const mode = prop_type.includes("pitching") ? "pvb" : "bvp";

  let box;
  try {
    box = await getBoxscoreFromGameID(game_id);
  } catch (err) {
    console.warn(`❌ Failed to fetch boxscore for game ${game_id}`);
    return;
  }

  if (!box?.teams?.home?.players || !box?.teams?.away?.players) {
    console.warn(`❌ Incomplete boxscore data for game ${game_id}`);
    return;
  }

  const playerTeam = getPlayerTeamFromBoxscore(box, player_id);

  if (!playerTeam) {
    console.warn(`❓ Could not determine player's team in game ${game_id}`);
    console.warn(`⚠️ Skipping ${id} due to missing opponent info`);
    return;
  }

  const opponentTeam = playerTeam === "home" ? "away" : "home";

  const options = { mode };

  if (mode === "bvp") {
    options.batter_id = player_id;

    const pitcherEntry = Object.values(
      box.teams[opponentTeam].players || {}
    ).find((p) => p?.stats?.pitching?.inningsPitched);

    if (!pitcherEntry) {
      console.warn(`⚠️ No opponent pitcher found for game ${game_id}`);
      console.warn(`⚠️ Skipping ${id} due to missing opponent`);
      return;
    }

    options.pitcher_id = pitcherEntry.person.id;
  } else {
    options.pitcher_id = player_id;

    const batterEntry = Object.values(
      box.teams[opponentTeam].players || {}
    ).find((p) => p?.stats?.batting?.atBats > 0);

    if (!batterEntry) {
      console.warn(`⚠️ No opponent batter found for game ${game_id}`);
      console.warn(`⚠️ Skipping ${id} due to missing opponent`);
      return;
    }

    options.batter_id = batterEntry.person.id;
  }

  const stats = await resolveStatForPlayer(options);

  if (!stats) {
    console.warn(`⚠️ No stats returned for ${id} (mode=${mode})`);
    return;
  }

  const updates = {};

  if (mode === "bvp") {
    updates.bvp_ab = stats.ab;
    updates.bvp_hits = stats.hits;
    updates.bvp_hr = stats.home_runs;
    updates.bvp_strikeouts = stats.strikeouts;
    updates.bvp_walks = stats.walks;
    updates.bvp_plate_appearances = stats.pa;
  } else {
    updates.pvb_ab = stats.ab;
    updates.pvb_hits = stats.hits;
    updates.pvb_hr = stats.home_runs;
    updates.pvb_strikeouts = stats.strikeouts;
    updates.pvb_walks = stats.walks;
    updates.pvb_plate_appearances = stats.pa;
  }

  const { error } = await supabase
    .from("model_training_props")
    .update(updates)
    .eq("id", id);

  if (error) {
    console.error(`❌ Failed to update row ${id}:`, error.message);
  } else {
    console.log(`✅ Updated ${id} (${mode}) with ${stats.pa} PA`);
  }
}

async function run() {
  let offset = 0;
  const batchSize = 1000;
  let batchCount = 0;

  while (true) {
    const rows = await fetchRowsNeedingStats(offset, batchSize);
    if (!rows.length) break;

    console.log(
      `🚀 Batch ${++batchCount}: Processing ${
        rows.length
      } rows (offset ${offset})`
    );

    for (let i = 0; i < rows.length; i++) {
      await processRow(rows[i], i, rows.length);
    }

    offset += batchSize;
  }

  console.log("🏁 All batches complete");
}

run().catch((err) => {
  console.error("💥 Script crashed during run():", err.message);
});
