import { supabase } from "../backend/scripts/shared/supabaseUtils.js";
import { getGameTimeFromID } from "../backend/scripts/shared/fetchSchedule.js";
import {
  getFullTeamAbbreviationFromID,
  getOpponentAbbreviation,
} from "../backend/scripts/shared/teamNameMap.js";

const BATCH_SIZE = 10000;
const CONCURRENCY = 4;

console.log("🚀 Starting game context backfill...");

async function fetchNextBatch() {
  const { data, error } = await supabase
    .from("model_training_props")
    .select(
      "id, game_id, team_id, opponent, opponent_encoded, is_home, home_away, game_time, time_of_day_bucket, game_day_of_week, player_id, position"
    )
    .or(
      [
        "game_time.is.null",
        "time_of_day_bucket.is.null",
        "game_day_of_week.is.null",
        "is_home.is.null",
        "home_away.is.null",
        "opponent_encoded.is.null",
        "position.is.null",
      ].join(",")
    )
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("❌ Error fetching rows:", error.message);
    return [];
  }

  console.log(`📤 Fetched ${data.length} rows`);
  return data;
}

async function processBatch(rows) {
  console.log(`🔄 Processing batch of ${rows.length} rows...`);
  const updates = [];

  for (const row of rows) {
    const {
      id,
      game_id,
      team_id,
      opponent,
      opponent_encoded,
      is_home,
      home_away,
      game_time,
      time_of_day_bucket,
      game_day_of_week,
      player_id,
      position,
    } = row;

    const updateFields = {};

    // 🕒 Game time & day of week
    if (!game_time || !time_of_day_bucket || !game_day_of_week) {
      try {
        const time = await getGameTimeFromID(game_id);
        if (time) {
          if (!game_time) updateFields.game_time = time;
          const dt = new Date(time);
          if (!game_day_of_week) updateFields.game_day_of_week = dt.getUTCDay();
          if (!time_of_day_bucket) {
            const hour = dt.getUTCHours();
            updateFields.time_of_day_bucket =
              hour < 12
                ? "morning"
                : hour < 17
                ? "afternoon"
                : hour < 20
                ? "evening"
                : "night";
          }
        }
      } catch (err) {
        console.warn(
          `⚠️ Failed to get game time for ${game_id}: ${err.message}`
        );
      }
    }

    // 🏟️ Opponent + home/away
    if ((!opponent_encoded || !is_home || !home_away) && team_id && game_id) {
      try {
        const teamAbbr = getFullTeamAbbreviationFromID(team_id);
        const opponentAbbr = await getOpponentAbbreviation(teamAbbr, game_id);
        if (opponentAbbr) {
          if (!opponent_encoded) updateFields.opponent_encoded = opponentAbbr;
          if (!opponent) updateFields.opponent = opponentAbbr;
        }

        const homeTeamIsSelf =
          teamAbbr === (await getHomeTeamAbbreviation(game_id));
        if (is_home === null || is_home === undefined)
          updateFields.is_home = homeTeamIsSelf;
        if (!home_away)
          updateFields.home_away = homeTeamIsSelf ? "home" : "away";
      } catch (err) {
        console.warn(
          `⚠️ Failed opponent/home check for ${game_id}: ${err.message}`
        );
      }
    }

    // 🧍 Position from player_stats
    if (!position) {
      const { data: player } = await supabase
        .from("player_stats")
        .select("position")
        .eq("player_id", player_id)
        .limit(1)
        .single();

      if (player?.position) {
        updateFields.position = player.position;
      }
    }

    if (Object.keys(updateFields).length > 0) {
      updates.push({ id, ...updateFields });
    }
  }

  for (const chunk of chunkArray(updates, 1000)) {
    await supabase
      .from("model_training_props")
      .upsert(chunk, { onConflict: "id" });
    console.log(`📥 Updated ${chunk.length} rows.`);
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// 🏠 Helper to get home team abbreviation for a game
async function getHomeTeamAbbreviation(gameId) {
  const url = `https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`;
  const res = await fetch(url);
  const json = await res.json();
  const homeTeamId = json.teams?.home?.team?.id;
  return getFullTeamAbbreviationFromID(homeTeamId);
}

async function runConcurrent() {
  const workers = Array(CONCURRENCY)
    .fill(null)
    .map(async () => {
      while (true) {
        const batch = await fetchNextBatch();
        if (batch.length === 0) break;
        await processBatch(batch);
      }
    });

  await Promise.all(workers);
  console.log("✅ All game context backfills complete.");
}

runConcurrent();
