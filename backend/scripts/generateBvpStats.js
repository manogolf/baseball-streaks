// backend/scripts/generateBvpStats.js

import { supabase } from "./shared/supabaseBackend.js";
import { getLiveFeedFromGameID } from "./shared/mlbApiUtils.js";
import { setIfMissing } from "../../shared/objectUtils.js";
import dayjs from "dayjs";

const BATCH_DELAY_MS = 500;
const BUCKET_SIZE = 10000;

let totalInserted = 0;
let totalSkipped = 0;
let totalFailed = 0;

async function runFullBackfill() {
  const argStart = process.argv.find((arg) => arg.startsWith("--startDate="));
  const argEnd = process.argv.find((arg) => arg.startsWith("--endDate="));

  const startDate = argStart
    ? argStart.split("=")[1]
    : dayjs().subtract(1, "day").format("YYYY-MM-DD");

  const endDate = argEnd ? argEnd.split("=")[1] : null;

  console.log(
    `🚀 Starting full BvP backfill from ${startDate}${
      endDate ? ` to ${endDate}` : ""
    }`
  );

  let offset = 0;

  while (true) {
    console.log(`📦 Fetching batch at offset ${offset}`);

    // Build Supabase query with dynamic date filters
    let query = supabase
      .from("model_training_props")
      .select("game_id")
      .eq("prop_source", "mlb_api")
      .gte("game_date", startDate);

    if (endDate) {
      query = query.lte("game_date", endDate);
    }

    query = query
      .order("game_date", { ascending: false })
      .range(offset, offset + BUCKET_SIZE - 1);

    const { data: games, error: fetchError } = await query;

    if (fetchError) {
      if (fetchError.message?.includes("timeout")) {
        console.warn(`⚠️ Timeout at offset ${offset}, skipping to next batch`);
        offset += BUCKET_SIZE;
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        continue;
      } else {
        console.error("❌ Failed to fetch recent games:", fetchError);
        break;
      }
    }

    if (!games || games.length === 0) {
      console.log("✅ No more games to process. Done.");
      break;
    }

    const uniqueGameIds = [...new Set(games.map((g) => g.game_id))];

    for (const gameId of uniqueGameIds) {
      try {
        await processGame(gameId);
      } catch (e) {
        console.error(`❌ Error processing game ${gameId}:`, e);
      }

      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }

    offset += BUCKET_SIZE;
  }
  console.log("🏁 Full BvP backfill complete");
  console.log(
    `📊 Totals — Inserted=${totalInserted}, Skipped=${totalSkipped}, Failed=${totalFailed}`
  );
}

let inserted = 0;
let updated = 0; // ← new
let skipped = 0;
let failed = 0;

async function processGame(gameId) {
  console.log(`🎯 Target game: ${gameId}`);

  const liveFeed = await getLiveFeedFromGameID(gameId);
  const allPlays = liveFeed?.liveData?.plays?.allPlays || [];

  const gameType = liveFeed?.gameData?.game?.type;
  if (gameType !== "R") {
    console.warn(
      `⏩ Skipping non-regular season game ${gameId} (type=${gameType})`
    );
    return;
  }

  // ---- robust starter detection
  const probableHome = liveFeed?.gameData?.probablePitchers?.home?.id ?? null;
  const probableAway = liveFeed?.gameData?.probablePitchers?.away?.id ?? null;

  const boxHomeFirst =
    liveFeed?.liveData?.boxscore?.teams?.home?.pitchers?.[0] ?? null;
  const boxAwayFirst =
    liveFeed?.liveData?.boxscore?.teams?.away?.pitchers?.[0] ?? null;

  // fallback via first-half-inning pitchers (top → home fields; bottom → away fields)
  const firstTop = allPlays.find(
    (p) => p.about?.inning === 1 && p.about?.halfInning === "top"
  );
  const firstBot = allPlays.find(
    (p) => p.about?.inning === 1 && p.about?.halfInning === "bottom"
  );
  const topPitcher = firstTop?.matchup?.pitcher?.id ?? null; // home starter
  const bottomPitcher = firstBot?.matchup?.pitcher?.id ?? null; // away starter

  const homeStarterId = probableHome ?? boxHomeFirst ?? topPitcher ?? null;
  const awayStarterId = probableAway ?? boxAwayFirst ?? bottomPitcher ?? null;

  if (!homeStarterId || !awayStarterId) {
    console.warn(
      `⚠️ Missing starters for game ${gameId} (home=${homeStarterId}, away=${awayStarterId})`
    );
    // we can still proceed but many batters may resolve to null pitcher → skip
  }

  // sets of which batters belong to which team (for default mapping)
  const homeBatters = new Set(
    liveFeed?.liveData?.boxscore?.teams?.home?.batters || []
  );
  const awayBatters = new Set(
    liveFeed?.liveData?.boxscore?.teams?.away?.batters || []
  );

  const starters = new Set([homeStarterId, awayStarterId].filter(Boolean));

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
  let inserted = 0,
    skipped = 0,
    failed = 0;

  for (const row of rows) {
    const batterId = Number(row.player_id);
    if (!Number.isFinite(batterId)) {
      skipped++;
      continue;
    }

    if (!bvpStatsCache.has(batterId)) {
      // default opponent pitcher by team membership
      const defaultPitcherId = homeBatters.has(batterId)
        ? awayStarterId ?? null
        : awayBatters.has(batterId)
        ? homeStarterId ?? null
        : null;

      // try to find an actual PA vs a starter
      const playVsStarter = allPlays.find(
        (p) =>
          p.matchup?.batter?.id === batterId &&
          starters.has(p.matchup?.pitcher?.id)
      );

      const pitcherId = playVsStarter?.matchup?.pitcher?.id ?? defaultPitcherId;

      if (!pitcherId) {
        // no way to resolve; cache a sentinel to avoid rework
        bvpStatsCache.set(batterId, null);
      } else {
        const stats = computeBvpStats(batterId, pitcherId, allPlays);
        bvpStatsCache.set(batterId, { pitcherId, stats });
      }
    }

    const cached = bvpStatsCache.get(batterId);
    if (!cached) {
      skipped++;
      continue;
    }

    const { pitcherId, stats } = cached;
    // Option: insert zeros when no PAs occurred (toggle via env)
    const INSERT_ZERO_ROWS = process.env.BVP_INSERT_ZEROS === "true";
    if (!stats && !INSERT_ZERO_ROWS) {
      skipped++;
      continue;
    }

    // When stats are null and zero-rows are allowed, synthesize zeros
    const effective = stats ?? {
      pa: 0,
      ab: 0,
      hits: 0,
      home_runs: 0,
      strikeouts: 0,
      walks: 0,
      rbi: 0,
      total_bases: 0,
    };

    // Check what’s already there
    // 1) Preselect (you already have this, keep it)
    const { data: existingRows, error: selErr } = await supabase
      .from("bvp_stats")
      .select(
        "bvp_plate_appearances,bvp_at_bats,bvp_hits,bvp_home_runs,bvp_strikeouts,bvp_walks,bvp_rbi,bvp_total_bases"
      )
      .eq("game_id", gameId)
      .eq("batter_id", String(batterId))
      .eq("pitcher_id", String(pitcherId))
      .limit(1);

    const existed = (existingRows?.length ?? 0) > 0; // ← did it exist?
    const existing = existingRows?.[0] || {};

    // 2) Build upsert payload with setIfMissing (unchanged)
    const upsertPayload = {
      game_id: gameId,
      batter_id: String(batterId),
      pitcher_id: String(pitcherId),
    };

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

    // 3) Track whether we actually changed anything (beyond the 3 key fields)
    const changed = Object.keys(upsertPayload).length > 3;

    // 4) Upsert + correct counters
    const { error: upsertError } = await supabase
      .from("bvp_stats")
      .upsert(upsertPayload, { onConflict: "game_id,batter_id,pitcher_id" });

    if (upsertError) {
      console.error(
        `❌ Failed to upsert BvP for batter ${row.player_id}:`,
        upsertError
      );
      failed++;
    } else {
      if (!existed && changed) {
        // brand-new row with values
        console.log(`📦 Inserted BvP stats for batter ${row.player_id}`);
        inserted++;
      } else if (existed && changed) {
        // existing row gained previously-missing fields
        console.log(`🛠️ Updated BvP stats for batter ${row.player_id}`);
        // either track an `updated++` counter, or count as skipped if you only want Inserted/Skipped/Failed
        // updated++;
        skipped++;
      } else {
        // nothing new to set
        console.log(
          `⚠️ Skipped — no new BvP values for batter ${row.player_id}`
        );
        skipped++;
      }
    }

    setIfMissing(
      upsertPayload,
      "bvp_plate_appearances",
      effective.pa,
      existing.bvp_plate_appearances
    );
    setIfMissing(
      upsertPayload,
      "bvp_at_bats",
      effective.ab,
      existing.bvp_at_bats
    );
    setIfMissing(upsertPayload, "bvp_hits", effective.hits, existing.bvp_hits);
    setIfMissing(
      upsertPayload,
      "bvp_home_runs",
      effective.home_runs,
      existing.bvp_home_runs
    );
    setIfMissing(
      upsertPayload,
      "bvp_strikeouts",
      effective.strikeouts,
      existing.bvp_strikeouts
    );
    setIfMissing(
      upsertPayload,
      "bvp_walks",
      effective.walks,
      existing.bvp_walks
    );
    setIfMissing(upsertPayload, "bvp_rbi", effective.rbi, existing.bvp_rbi);
    setIfMissing(
      upsertPayload,
      "bvp_total_bases",
      effective.total_bases,
      existing.bvp_total_bases
    );

    const hasNewValues = Object.keys(upsertPayload).length > 3;

    if (!hasNewValues) {
      console.log(
        `⚠️ Skipped upsert — no new BvP values for batter ${row.player_id}`
      );
      skipped++;
      continue;
    }

    if (upsertError) {
      console.error(
        `❌ Failed to upsert BvP for batter ${row.player_id}:`,
        upsertError
      );
      failed++;
    } else {
      console.log(
        `📦 Upserted BvP for batter ${row.player_id} vs ${pitcherId}`
      );
      inserted++;
    }
  }

  console.log(
    `✅ Game ${gameId} complete: Inserted=${inserted}, Skipped=${skipped}, Failed=${failed}`
  );
  totalInserted += inserted;
  totalSkipped += skipped;
  totalFailed += failed;
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
runFullBackfill().catch((err) => {
  console.error("❌ Uncaught error in full BvP backfill:", err);
});
