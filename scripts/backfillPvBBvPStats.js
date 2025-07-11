// File: scripts/backfillPvBBvPStats.js

import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import { resolveStatForPlayer } from "../backend/scripts/resolution/statResolvers.js";
import { getBoxscoreFromGameID } from "../backend/scripts/shared/mlbApiUtils.js";
import { getPlayerTeamFromBoxscoreData } from "../backend/scripts/shared/playerUtils.js";

import fetch from "node-fetch";

const DELAY_MS = 200;

const MISSING_CONDITIONS = [
  "pvb_at_bats=is.null",
  "pvb_hits=is.null",
  "pvb_home_runs=is.null",
  "pvb_strikeouts=is.null",
  "pvb_walks=is.null",
  "pvb_plate_appearances=is.null",
  "pvb_rbi=is.null",
  "pvb_total_bases=is.null",
  "pvb_sac_flies=is.null",
  "bvp_at_bats=is.null",
  "bvp_hits=is.null",
  "bvp_home_runs=is.null",
  "bvp_strikeouts=is.null",
  "bvp_walks=is.null",
  "bvp_plate_appearances=is.null",
  "bvp_rbi=is.null",
];

// Break into 2 OR groups
const orGroup1 = MISSING_CONDITIONS.slice(0, 8).join(",");
const orGroup2 = MISSING_CONDITIONS.slice(8).join(",");

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchRowsNeedingStats(offset, limit) {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("id, player_id, prop_type, game_id")
    .not("player_id", "is", null)
    .not("game_id", "is", null)
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("❌ Failed to fetch base rows:", error.message);
    return [];
  }

  // Filter in JS: keep rows where at least one target field is null
  const columnsToCheck = [
    "pvb_at_bats",
    "pvb_hits",
    "pvb_home_runs",
    "pvb_strikeouts",
    "pvb_walks",
    "pvb_plate_appearances",
    "pvb_rbi",
    "pvb_total_bases",
    "pvb_sac_flies",
    "bvp_at_bats",
    "bvp_hits",
    "bvp_home_runs",
    "bvp_strikeouts",
    "bvp_walks",
    "bvp_plate_appearances",
    "bvp_rbi",
  ];

  return data.filter((row) =>
    columnsToCheck.some((col) => row[col] === null || row[col] === undefined)
  );
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
    if (!box || !box.teams?.home?.players || !box.teams?.away?.players) {
      console.warn(
        `❌ Skipping ${id} — incomplete boxscore for game ${game_id}`
      );
      return;
    }
  } catch (err) {
    console.error(`❌ Error fetching boxscore for game ${game_id}:`, err);
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
    updates.bvp_at_bats = stats.ab;
    updates.bvp_hits = stats.hits;
    updates.bvp_home_runs = stats.home_runs;
    updates.bvp_strikeouts = stats.strikeouts;
    updates.bvp_walks = stats.walks;
    updates.bvp_plate_appearances = stats.pa;
    updates.bvp_rbi = stats.rbi;
  } else {
    updates.pvb_at_bats = stats.ab;
    updates.pvb_hits = stats.hits;
    updates.pvb_home_runs = stats.home_runs;
    updates.pvb_strikeouts = stats.strikeouts;
    updates.pvb_walks = stats.walks;
    updates.pvb_plate_appearances = stats.pa;
    updates.pvb_rbi = stats.rbi;
    updates.pvb_total_bases = stats.total_bases;
    updates.pvb_sac_flies = stats.sac_flies;
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
    console.log(
      `✅ Updated ${id} | ${mode.toUpperCase()} | PA: ${stats.plateAppearances}`
    );
  }
}

async function run() {
  let offset = parseInt(process.env.START_OFFSET || "0", 10);
  const batchSize = 1000;
  let batchCount = 0;

  console.log(`🟢 Starting at offset: ${offset}`);

  while (true) {
    const rows = await fetchRowsNeedingStats(offset, batchSize);
    if (!rows.length) break;

    console.log(
      `🚀 Batch ${++batchCount}: Processing ${
        rows.length
      } rows (offset ${offset})`
    );

    for (let i = 0; i < rows.length; i++) {
      await processRow(rows[i]);
    }

    offset += batchSize;
  }

  console.log("🏁 All batches complete");
}

run().catch((err) => {
  console.error("💥 Script crashed during run():", err.message);
});
