// scripts/backfillGameContextFields.js
import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
  toEasternDateTime,
} from "../backend/scripts/shared/timeUtils.js";
import { fetchBoxscoreStatsForGame } from "../backend/scripts/shared/fetchBoxscoreStats.js";
import { getTeamIdFromAbbr } from "../backend/scripts/shared/teamNameMap.js";

const BATCH_SIZE = 1000;
const CONCURRENCY = 4;

async function fetchNextBatch() {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("id, game_id, game_date, team, is_home")
    .is("game_time", null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error("❌ Failed to fetch batch:", error.message);
    return [];
  }
  return data;
}

async function processRow(row) {
  const { id, game_id, game_date, team } = row;
  const boxscore = await fetchBoxscoreStatsForGame(game_id);
  if (!boxscore || !Array.isArray(boxscore)) return null;

  const playerTeam = team;
  const isHome = boxscore.find((p) => p.teamAbbr === playerTeam)?.isHome;
  const opponentTeam = boxscore.find(
    (p) => p.teamAbbr !== playerTeam && p.isHome !== isHome
  )?.teamAbbr;

  const opponent_encoded = getTeamIdFromAbbr(opponentTeam);

  const game_time = await getGameStartTimeET(game_id);
  if (!game_time) return null;

  const gameDateTimeET = toEasternDateTime(game_date, game_time);
  const game_day_of_week = getDayOfWeekET(gameDateTimeET);
  const time_of_day_bucket = getTimeOfDayBucketET(gameDateTimeET);

  return {
    id,
    updates: {
      game_time: gameDateTimeET,
      game_day_of_week,
      time_of_day_bucket,
      is_home: isHome ? 1 : 0,
      home_away: isHome ? "home" : "away",
      opponent: opponentTeam || null,
      opponent_encoded,
    },
  };
}

async function processBatch(batch) {
  const updates = [];

  for (const row of batch) {
    const result = await processRow(row);
    if (result) updates.push(result);
  }

  for (const entry of updates) {
    const { id, updates: fields } = entry;
    const { error } = await supabase
      .from("model_training_props")
      .update(fields)
      .eq("id", id);

    if (error) {
      console.error(`❌ Update failed for ID ${id}:`, error.message);
    } else {
      console.log(`📥 Updated ID ${id}`);
    }
  }
}

async function runConcurrent() {
  console.log("🚀 Starting game context backfill...");

  const workers = Array(CONCURRENCY)
    .fill(null)
    .map(async () => {
      while (true) {
        const batch = await fetchNextBatch();
        if (!batch.length) break;
        await processBatch(batch);
      }
    });

  await Promise.all(workers);
  console.log("✅ All game context backfills complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConcurrent();
}
