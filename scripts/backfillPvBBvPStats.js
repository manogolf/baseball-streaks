// File: scripts/backfillPvBBvPStats.js

import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import { resolveStatForPlayer } from "../backend/scripts/resolution/statResolvers.js";
import { getBoxscoreFromGameID } from "../backend/scripts/shared/mlbApiUtils.js";
import { getPlayerTeamFromBoxscoreData } from "../backend/scripts/shared/playerUtils.js";

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

async function processRow(row) {
  const { id, player_id, prop_type, game_id } = row;
  const mode = prop_type.includes("pitching") ? "pvb" : "bvp";

  console.log(
    `🧪 ${mode.toUpperCase()} | Row: ${id} | Prop: ${prop_type} | Game: ${game_id}`
  );

  let box;
  try {
    box = await getBoxscoreFromGameID(game_id);
    if (
      !box ||
      !box.teams?.home?.players ||
      !box.teams?.away?.players ||
      Object.keys(box.teams.home.players).length === 0 ||
      Object.keys(box.teams.away.players).length === 0
    ) {
      console.warn(
        `❌ Skipping ${id} — incomplete boxscore for game ${game_id}`
      );
      return;
    }
  } catch (err) {
    console.error(
      `❌ Exception while fetching boxscore for game ${game_id}:`,
      err
    );
    return;
  }

  const playerTeam = getPlayerTeamFromBoxscoreData(box, player_id);
  if (!playerTeam) {
    console.warn(
      `❌ Skipping ${id} — could not determine player's team in game ${game_id}`
    );
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
      console.warn(
        `⚠️ Skipping ${id} — missing opponent pitcher in game ${game_id}`
      );
      return;
    }
    options.pitcher_id = pitcherEntry.person.id;
  } else {
    options.pitcher_id = player_id;
    const batterEntry = Object.values(
      box.teams[opponentTeam].players || {}
    ).find((p) => p?.stats?.batting?.atBats > 0);
    if (!batterEntry) {
      console.warn(
        `⚠️ Skipping ${id} — missing opponent batter in game ${game_id}`
      );
      return;
    }
    options.batter_id = batterEntry.person.id;
  }

  const result = await resolveStatForPlayer(options);
  if (!result || !result.rawStats) {
    console.warn(
      `⚠️ Skipping ${id} — no stats returned from resolveStatForPlayer`
    );
    return;
  }

  const stats = result.rawStats;
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

  const allValues = Object.values(updates);
  const allUndefined = allValues.every((v) => v === undefined);
  if (allUndefined) {
    console.warn(`⚠️ Skipping ${id} — all stat values undefined`);
    return;
  }

  const { error } = await supabase
    .from("model_training_props")
    .update(updates)
    .eq("id", id);

  if (error) {
    console.error(`❌ Update failed for ${id}: ${error.message}`);
  } else {
    console.log(`✅ Updated ${id} | ${mode.toUpperCase()} | PA: ${stats.pa}`);
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
