// scripts/insertStatDerivedProps.js
import { supabase } from "../../src/scripts/shared/supabaseUtils.js";
import fetch from "node-fetch";
import "dotenv/config.js";

import { yesterdayET } from "../../src/scripts/shared/timeUtils.js";
import {
  extractStatForPropType,
  normalizePropType,
} from "../../src/scripts/shared/propUtils.js";

const MLB_API_URL = "https://statsapi.mlb.com/api/v1";

async function fetchFinalizedGameIds(date) {
  const url = `${MLB_API_URL}/schedule?sportId=1&date=${date}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch schedule: ${res.status}`);

  const json = await res.json();
  const games = json.dates?.[0]?.games || [];

  return games
    .filter((g) => g.status.detailedState === "Final")
    .map((g) => g.gamePk);
}

async function fetchBoxscore(gameId) {
  const res = await fetch(`${MLB_API_URL}/game/${gameId}/boxscore`);
  if (!res.ok) {
    console.warn(`⚠️ Failed to fetch boxscore for game ${gameId}`);
    return null;
  }

  const json = await res.json();
  const allPlayers = [];

  for (const side of ["home", "away"]) {
    const players = json.teams?.[side]?.players || {};
    for (const id in players) {
      const p = players[id];
      const stats = p?.stats?.batting;
      if (!stats) continue;

      allPlayers.push({
        id: p.person.id,
        fullName: p.person.fullName,
        team: json.teams[side]?.team?.abbreviation || "UNK",
        stats,
        gameDate: json.gameData?.datetime?.originalDate || null,
        isPitcher: false,
      });
    }
  }

  return allPlayers;
}

async function insertStatDerivedProps(gameId) {
  const players = await fetchBoxscore(gameId);
  if (!players) return;

  for (const player of players) {
    const allPropTypes = [
      "hits",
      "runs_scored",
      "rbis",
      "home_runs",
      "singles",
      "doubles",
      "triples",
      "walks",
      "strikeouts_batting",
      "stolen_bases",
      "total_bases",
      "hits_runs_rbis",
      "runs_rbis",
      "outs_recorded",
      "strikeouts_pitching",
      "walks_allowed",
      "earned_runs",
      "hits_allowed",
    ];

    for (const rawType of allPropTypes) {
      const propType = normalizePropType(rawType);
      const value = extractStatForPropType(propType, player.stats);
      if (value == null || isNaN(value)) continue;

      const insertPayload = {
        id: crypto.randomUUID(),
        player_name: player.fullName,
        team: player.team,
        player_id: player.id,
        prop_type: propType,
        prop_value: null,
        result: value,
        outcome: null,
        is_pitcher: player.isPitcher,
        game_date: player.gameDate,
        game_id: gameId,
        over_under: null,
        source: "stat_derived",
        position: null,
        rolling_result_avg_7: null,
        hit_streak: null,
        win_streak: null,
      };

      const { error } = await supabase
        .from("model_training_props")
        .upsert(insertPayload, { onConflict: "id" });

      if (error) {
        console.warn(
          `❌ Failed to insert prop for ${player.fullName}: ${error.message}`
        );
      } else {
        console.log(`✅ Inserted: ${player.fullName} (${propType})`);
      }
    }
  }
}

async function main() {
  const targetDate = process.argv[2] || yesterdayET();
  console.log(`📆 Target Date: ${targetDate}`);

  try {
    const gameIds = await fetchFinalizedGameIds(targetDate);
    console.log(`🎯 ${gameIds.length} finalized games`);

    for (const gameId of gameIds) {
      await insertStatDerivedProps(gameId);
    }

    console.log("🏁 Done inserting stat-derived props.");
  } catch (err) {
    console.error("❌ Script error:", err.message);
  }
}

main();
