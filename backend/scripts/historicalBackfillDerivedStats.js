// 📄 File: backend/scripts/historicalBackfillDerivedStats.js

import { supabase } from "../scripts/shared/supabaseBackend.js";
import { getDerivedStats } from "./shared/getDerivedStats.js";
import { setIfMissing } from "../../src/shared/archive/objectUtils.js";
import dayjs from "dayjs";

const START_DATE = dayjs("2023-03-30");
const END_DATE = dayjs("2025-07-01");
const TOTAL_BUCKETS = 10;

const bucketArg = process.argv.find((arg) => arg.startsWith("--bucket="));
const [currentBucket, totalBuckets] = bucketArg
  ? bucketArg.replace("--bucket=", "").split("/").map(Number)
  : [null, null];

let playerGameHistory = new Map();

async function preloadPlayerGameHistory() {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id, game_date, game_id, prop_type, prop_value")
    .gte("game_date", START_DATE.format("YYYY-MM-DD"));

  if (error) {
    console.error("❌ Error preloading player history:", error);
    process.exit(1);
  }

  for (const row of data) {
    const key = String(row.player_id);
    if (!playerGameHistory.has(key)) playerGameHistory.set(key, []);
    playerGameHistory.get(key).push(row);
  }
}

async function getGameIdsByDate(dateStr) {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("game_id")
    .eq("game_date", dateStr);

  if (error) {
    console.error("❌ Error fetching game IDs:", error);
    return [];
  }
  return [...new Set(data.map((g) => g.game_id))];
}

async function processGame(gameId) {
  const { data: rows, error } = await supabase
    .from("model_training_props")
    .select("player_id, game_id, game_date")
    .eq("game_id", gameId);

  if (error || !rows?.length) return;

  const { data: existingRows, error: existingError } = await supabase
    .from("player_derived_stats")
    .select("player_id, game_id")
    .in("game_id", [gameId]);

  const existingMap = new Set(
    (existingRows || []).map((r) => `${r.player_id}_${r.game_id}`)
  );

  for (const row of rows) {
    const player_id = row.player_id;
    const game_date = row.game_date;
    const key = `${player_id}_${gameId}`;
    if (existingMap.has(key)) continue;

    const derivedStats = await getDerivedStats(
      player_id,
      game_date,
      gameId,
      playerGameHistory
    );

    if (!derivedStats || Object.keys(derivedStats).length === 0) continue;

    const cleaned = Object.fromEntries(
      Object.entries(derivedStats).filter(
        ([_, v]) => v !== null && v !== undefined && Number.isFinite(v)
      )
    );

    const upsertPayload = {
      player_id,
      game_id: gameId,
      game_date,
      ...cleaned,
    };

    if (Object.keys(upsertPayload).length <= 3) continue;

    const { error: upsertError } = await supabase
      .from("player_derived_stats")
      .upsert(upsertPayload, { onConflict: ["player_id", "game_id"] });

    if (upsertError) {
      console.error(`❌ Failed to upsert for ${player_id}:`, upsertError);
    } else {
      console.log(`📦 Upserted ${player_id} on ${game_date}`);
    }
  }
}

async function runBackfill() {
  console.log("🚀 Starting historical derived stats backfill...");
  await preloadPlayerGameHistory();

  const allDates = [];
  let cursor = START_DATE;
  while (cursor.isBefore(END_DATE)) {
    allDates.push(cursor.format("YYYY-MM-DD"));
    cursor = cursor.add(1, "day");
  }

  const bucketSize = Math.ceil(allDates.length / TOTAL_BUCKETS);
  const start = currentBucket ? (currentBucket - 1) * bucketSize : 0;
  const end = currentBucket ? currentBucket * bucketSize : allDates.length;
  const dateBucket = allDates.slice(start, end);

  for (const dateStr of dateBucket) {
    console.log(`📅 Processing date ${dateStr}`);
    const gameIds = await getGameIdsByDate(dateStr);
    for (const gameId of gameIds) {
      await processGame(gameId);
    }
  }

  console.log("🏁 Backfill complete for this bucket.");
}

runBackfill().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
