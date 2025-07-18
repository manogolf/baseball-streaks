/**
 * 📄 File: generateDerivedStats.js
 *
 * Populates the `player_derived_stats` table (d7d15d30) with derived stat features for recently played games.
 *
 * It works by:
 * - Fetching unique (player_id, game_date, game_id) rows from `model_training_props`
 * - Preloading 30 days of boxscores into a cache
 * - Computing derived stats using `getDerivedStats(...)`
 * - Writing/upserting derived features to Supabase, bucketed for parallelism
 *
 * Features:
 * - Supports optional --bucket=1/8 arguments for distributed runs
 * - Suppresses logs unless --verbose is passed
 * - Includes fetch timeout protection and Supabase error escalation
 *
 * Intended to be run daily via cron to ensure fresh derived stats are available for modeling.
 */

//  backend/scripts/generateDerivedStats.js

import { supabase } from "./shared/supabaseUtils.js";
import { getDerivedStats } from "./shared/getDerivedStats.js";
import { toISODate } from "./shared/timeUtils.js";
import fetch from "node-fetch";

const LOOKBACK_DAYS = 2;
const TOTAL_BUCKETS = 8;

const verbose = process.argv.includes("--verbose");
const log = (...args) => verbose && console.log(...args);

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("⏱️ Fetch timed out")), timeoutMs)
    ),
  ]);
}

const bucketArg = process.argv.find((arg) => arg.startsWith("--bucket="));
const [currentBucket, totalBuckets] = bucketArg
  ? bucketArg.replace("--bucket=", "").split("/").map(Number)
  : [null, null];

async function getRecentPlayerGames() {
  const cutoffDate = toISODate(new Date(Date.now() - LOOKBACK_DAYS * 86400000));

  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id, game_date, game_id")
    .gte("game_date", cutoffDate)
    .not("player_id", "is", null)
    .order("game_date", { ascending: true });

  if (error)
    throw new Error("❌ Failed to fetch recent games: " + error.message);

  const seen = new Set();
  return data.filter((row) => {
    const key = `${row.player_id}_${row.game_date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function preloadBoxscores() {
  const boxscoreCache = new Map();
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 30);

  for (let d = new Date(from); d <= today; d.setDate(d.getDate() + 1)) {
    const iso = toISODate(d);
    const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${iso}`;

    try {
      const schedRes = await fetchWithTimeout(schedUrl).then((r) => r.json());
      const gameIds = (schedRes?.dates?.[0]?.games || []).map((g) => g.gamePk);
      if (!Array.isArray(gameIds) || gameIds.length === 0) continue;

      for (const gamePk of gameIds) {
        if (!boxscoreCache.has(gamePk)) {
          const boxUrl = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
          const boxRes = await fetch(boxUrl)
            .then((r) => r.json())
            .catch(() => null);
          if (boxRes) boxscoreCache.set(gamePk, boxRes);
        }
      }

      log(`📦 Cached boxscores for ${iso} (${gameIds.length} games)`);
    } catch (err) {
      console.warn(`⚠️ Failed to preload schedule for ${iso}: ${err.message}`);
    }
  }

  return boxscoreCache instanceof Map ? boxscoreCache : new Map();
}

async function updateDerivedStats(rows, boxscoreCache) {
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const { player_id, game_date, game_id } = rows[i];
    log(`⏳ (${i + 1}/${rows.length}) Player ${player_id} on ${game_date}`);

    try {
      const derivedStats = await getDerivedStats(
        player_id,
        game_date,
        game_id,
        boxscoreCache
      );

      const isEmpty =
        Object.keys(derivedStats).length === 0 ||
        Object.values(derivedStats).every((v) => v == null);

      if (isEmpty) {
        log(`🟡 Skipped: No usable stats`);
        skipped++;
        continue;
      }

      const { error } = await supabase.from("player_derived_stats").upsert(
        {
          player_id,
          game_date,
          game_id,
          ...derivedStats,
        },
        { onConflict: ["player_id", "game_date"] }
      );

      if (error) {
        throw new Error(`❌ Supabase error: ${error.message}`);
      }

      updated++;
    } catch (err) {
      console.warn(
        `⚠️ Failed for player ${player_id} on ${game_date}: ${err.message}`
      );
    }
  }

  log(`\n✅ Bucket complete: ${updated} updated, ${skipped} skipped`);
}

async function run() {
  log("📥 Fetching recent player-game combinations...");
  const allRows = await getRecentPlayerGames();
  log(`📦 Total unique (player_id, game_date): ${allRows.length}`);

  log("🚀 Preloading boxscores into cache...");
  const boxscoreCache = await preloadBoxscores();

  if (!boxscoreCache || typeof boxscoreCache.entries !== "function") {
    throw new Error("❌ preloadBoxscores() failed or returned invalid cache");
  }

  log(`📊 Boxscore cache size: ${boxscoreCache.size}`);

  if (currentBucket && totalBuckets) {
    const bucketSize = Math.ceil(allRows.length / totalBuckets);
    const start = (currentBucket - 1) * bucketSize;
    const end = currentBucket * bucketSize;
    const bucketRows = allRows.slice(start, end);

    log(
      `🔢 Running bucket ${currentBucket}/${totalBuckets} [${start} → ${end}]`
    );
    await updateDerivedStats(bucketRows, boxscoreCache);
  } else {
    for (let i = 1; i <= TOTAL_BUCKETS; i++) {
      const bucketSize = Math.ceil(allRows.length / TOTAL_BUCKETS);
      const start = (i - 1) * bucketSize;
      const end = i * bucketSize;
      const bucketRows = allRows.slice(start, end);

      log(
        `\n⏳ Starting bucket ${i}/${TOTAL_BUCKETS} [${start} → ${end}]...\n`
      );
      await updateDerivedStats(bucketRows, boxscoreCache);
    }

    log(`\n🎉 All ${TOTAL_BUCKETS} buckets processed.`);
  }
}

run().catch((err) => {
  console.error("❌ generateDerivedStats failed:", err);
  process.exit(1);
});
