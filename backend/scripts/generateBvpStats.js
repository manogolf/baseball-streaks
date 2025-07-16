// backend/scripts/generateBvpStats.js

import { supabase } from "./shared/supabaseUtils.js";
import { getLiveFeedFromGameID } from "./shared/mlbApiUtils.js";
import { setIfMissing } from "./shared/objectUtils.js";
import dayjs from "dayjs";

const BATCH_DELAY_MS = 200;

const argDate = process.argv.find((arg) => arg.startsWith("--startDate="));
const startDate = argDate
  ? argDate.split("=")[1]
  : dayjs().subtract(1, "day").format("YYYY-MM-DD");

async function runRecentBackfill() {
  console.log(`🚀 Starting BvP backfill from ${startDate}`);

  const { data: games, error: fetchError } = await supabase
    .from("model_training_props")
    .select("game_id")
    .eq("prop_source", "mlb_api")
    .gte("game_date", startDate)
    .order("game_date", { ascending: false });

  if (fetchError) {
    console.error("❌ Failed to fetch recent games:", fetchError);
    return;
  }

  const uniqueGameIds = [...new Set(games.map((g) => g.game_id))];
  for (const gameId of uniqueGameIds) {
    const { count } = await supabase
      .from("bvp_stats")
      .select("id", { count: "exact", head: true })
      .eq("game_id", gameId);

    if (count > 0) {
      console.log(`⏭️ Skipping already-processed game ${gameId}`);
      continue;
    }

    try {
      await processGame(gameId);
    } catch (e) {
      console.error(`❌ Error processing game ${gameId}:`, e);
    }

    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log("🏁 Recent BvP backfill complete");
}

async function processGame(gameId) {
  console.log(`🎯 Target game: ${gameId}`);

  const liveFeed = await getLiveFeedFromGameID(gameId);
  const allPlays = liveFeed?.liveData?.plays?.allPlays || [];
  console.log(`🎮 Loaded ${allPlays.length} plays`);

  const { data: rows, error } = await supabase
    .from("model_training_props")
    .select("id, player_id")
    .eq("game_id", gameId)
    .eq("prop_source", "mlb_api");

  if (error) {
    console.error("❌ Error fetching props:", error);
    return;
  }

  const bvpStatsCache = new Map();

  for (const row of rows) {
    const batterId = parseInt(row.player_id);

    if (!bvpStatsCache.has(batterId)) {
      const matchup = allPlays.find((p) => p.matchup?.batter?.id === batterId);
      const pitcherId = matchup?.pitcher?.id;

      if (!pitcherId) {
        console.warn(`⚠️ Could not find pitcher for batter ${batterId}`);
        continue;
      }

      const stats = computeBvpStats(batterId, pitcherId, allPlays);
      if (!stats) {
        console.warn(`⚠️ No BvP stats found for batter ${batterId}`);
        continue;
      }

      bvpStatsCache.set(batterId, { pitcherId, stats });
    }

    const cached = bvpStatsCache.get(batterId);
    if (!cached) continue;

    const { pitcherId, stats } = cached;
    const upsertPayload = {
      game_id: gameId,
      batter_id: row.player_id,
      pitcher_id: pitcherId,
    };

    const { data: existingRows } = await supabase
      .from("bvp_stats")
      .select("bvp_plate_appearances")
      .eq("game_id", gameId)
      .eq("batter_id", row.player_id)
      .eq("pitcher_id", pitcherId)
      .limit(1);

    const existing = existingRows?.[0] || {};

    setIfMissing(
      upsertPayload,
      "bvp_plate_appearances",
      stats.pa,
      existing.bvp_plate_appearances
    );
    setIfMissing(upsertPayload, "bvp_at_bats", stats.ab, existing.bvp_at_bats);
    setIfMissing(upsertPayload, "bvp_hits", stats.hits, existing.bvp_hits);
    setIfMissing(
      upsertPayload,
      "bvp_home_runs",
      stats.home_runs,
      existing.bvp_home_runs
    );
    setIfMissing(
      upsertPayload,
      "bvp_strikeouts",
      stats.strikeouts,
      existing.bvp_strikeouts
    );
    setIfMissing(upsertPayload, "bvp_walks", stats.walks, existing.bvp_walks);
    setIfMissing(upsertPayload, "bvp_rbi", stats.rbi, existing.bvp_rbi);
    setIfMissing(
      upsertPayload,
      "bvp_total_bases",
      stats.total_bases,
      existing.bvp_total_bases
    );

    const { error: upsertError } = await supabase
      .from("bvp_stats")
      .upsert(upsertPayload, { onConflict: "game_id,batter_id,pitcher_id" });

    if (upsertError) {
      console.error(
        `❌ Failed to upsert BvP for batter ${row.player_id}:`,
        upsertError
      );
    } else if (Object.keys(upsertPayload).length > 3) {
      console.log(
        `📦 Upserted (setIfMissing) BvP stats for batter ${row.player_id}`
      );
    } else {
      console.log(
        `⚠️ Skipped upsert — no new BvP values for batter ${row.player_id}`
      );
    }
  }
}

function computeBvpStats(batterId, pitcherId, allPlays) {
  const relevantPlays = allPlays.filter(
    (p) =>
      p.matchup?.batter?.id === batterId && p.matchup?.pitcher?.id === pitcherId
  );

  if (relevantPlays.length === 0) return null;

  let pa = 0,
    ab = 0,
    hits = 0,
    home_runs = 0,
    strikeouts = 0,
    walks = 0,
    rbi = 0,
    total_bases = 0;

  for (const play of relevantPlays) {
    const result = play.result?.eventType;
    if (!result) continue;

    pa++;
    const isAB = ![
      "walk",
      "hit_by_pitch",
      "sac_bunt",
      "sac_fly",
      "catcher_interf",
    ].includes(result);
    if (isAB) ab++;

    switch (result) {
      case "single":
        hits++;
        total_bases += 1;
        break;
      case "double":
        hits++;
        total_bases += 2;
        break;
      case "triple":
        hits++;
        total_bases += 3;
        break;
      case "home_run":
        hits++;
        home_runs++;
        total_bases += 4;
        break;
      case "walk":
        walks++;
        break;
      case "strikeout":
        strikeouts++;
        break;
    }

    rbi += play.result?.rbi || 0;
  }

  return { pa, ab, hits, home_runs, strikeouts, walks, rbi, total_bases };
}

// 🔁 Run
runRecentBackfill().catch((err) => {
  console.error("❌ Uncaught error in recent BvP backfill:", err);
});
