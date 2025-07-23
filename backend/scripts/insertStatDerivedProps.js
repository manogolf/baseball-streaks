// backend/scripts/insertStatDerivedProps.js
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
  toISODate,
  toEasternDateTime,
} from "../../src/shared/timeUtils.js";
import { supabase } from "./shared/supabaseBackend.js";
import {
  extractStatForPropType,
  BATTER_PROP_TYPES,
  PITCHER_PROP_TYPES,
  isBatterProp,
  determineOutcome,
} from "../../src/shared/propUtils.js";
import { getStreaksForPlayer } from "../../src/shared/playerUtils.js";
import { fetchBoxscoreStatsForGame } from "./shared/fetchBoxscoreStats.js";
import {
  getGameContextFields,
  getLiveFeedFromGameID,
} from "./shared/mlbApiUtils.js";
import { getTeamIdFromAbbr } from "../../src/shared/teamNameMap.js";
import crypto from "node:crypto";

const verbose = process.argv.includes("--verbose");
const log = (...args) => {
  if (verbose) {
    console.log(...args);
  }
};
const forceLog = (...args) => console.log(...args);

const DAYS_AGO = 2;
const today = new Date();
const endDate = new Date(today);
endDate.setDate(endDate.getDate() - 1);
const startDate = new Date(today);
startDate.setDate(startDate.getDate() - DAYS_AGO);
const datesToProcess = [];
for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
  datesToProcess.push(toISODate(new Date(d)));
}

const LOG_EVERY = 150;
const SLEEP_MS = 10;

const propTypeWins = {};
const propTypeLosses = {};
let overCount = 0;
let underCount = 0;
let winCount = 0;
let lossCount = 0;

const propTypeInsertCounts = {};

const quietMode = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function shouldInclude(playerId, gameId, propType, ratio = 0.2) {
  const str = `${playerId}-${gameId}-${propType}`;
  const normalized = (hashString(str) % 1000) / 1000;
  return normalized < ratio;
}

async function processDate(gameDate) {
  log(`\n📅 ${gameDate}`);
  const schedURL = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}`;
  const schedRes = await fetch(schedURL)
    .then((r) => r.json())
    .catch(() => null);
  const gameIds = (schedRes?.dates?.[0]?.games || [])
    .filter((g) => g.status?.detailedState === "Final")
    .map((g) => g.gamePk);

  const teamContextCache = new Map();

  for (const gameId of gameIds) {
    try {
      log(`📍  Game ${gameId}`);
      const liveData = await getLiveFeedFromGameID(gameId);
      const allPlays = liveData?.liveData?.plays?.allPlays || [];
      const allPlayers = await fetchBoxscoreStatsForGame(gameId);
      if (!allPlayers) continue;

      const players = allPlayers.filter((p) => {
        const { batting = {}, pitching = {} } = p.stats || {};
        const hasBat = Object.keys(batting).length;
        const hasPitch = Object.keys(pitching).length;
        if (!hasBat && !hasPitch) return false;
        if (hasPitch && pitching.gamesStarted === 0) return false;
        return true;
      });

      log(`🔍 ${players.length} players to process`);
      let inserted = 0;

      for (const pl of players) {
        const { id: player_id, fullName, teamAbbr: team, isHome, stats } = pl;
        const hasBat = stats?.batting && Object.keys(stats.batting).length > 0;
        const isPitcher = stats?.pitching && stats.pitching.gamesStarted > 0;
        const isBatterOnly = hasBat && !isPitcher;
        const isPitcherOnly = isPitcher && !hasBat;
        const isTwoWayPlayer = hasBat && isPitcher;

        const opponentTeam = isHome
          ? allPlayers.find((p) => !p.isHome)
          : allPlayers.find((p) => p.isHome);
        const opponent = opponentTeam?.teamAbbr || null;
        const opponent_encoded = getTeamIdFromAbbr(opponent);
        const contextKey = `${gameId}_${team}`;
        let contextFields;

        if (teamContextCache.has(contextKey)) {
          contextFields = teamContextCache.get(contextKey);
        } else {
          contextFields = await getGameContextFields(gameId, team);
          teamContextCache.set(contextKey, contextFields);
        }

        const now = new Date().toISOString();

        let eligiblePropTypes = [];
        if (isBatterOnly || isTwoWayPlayer)
          eligiblePropTypes.push(...BATTER_PROP_TYPES);
        if (isPitcherOnly || isTwoWayPlayer)
          eligiblePropTypes.push(...PITCHER_PROP_TYPES);

        for (const propType of eligiblePropTypes) {
          if (isBatterOnly && isBatterProp(propType)) {
            if (!shouldInclude(player_id, gameId, propType)) continue;
          }

          const result = extractStatForPropType(propType, stats);
          if (result == null || typeof result !== "number" || isNaN(result))
            continue;

          const line = Math.random() < 0.5 ? result + 0.5 : result - 0.5;
          const over_under = Math.random() < 0.5 ? "over" : "under";
          const outcome = determineOutcome(result, line, over_under);
          if (!["win", "loss"].includes(outcome)) continue;

          const was_correct = outcome === "win";
          if (over_under === "over") overCount++;
          else underCount++;
          if (outcome === "win") winCount++;
          else lossCount++;
          propTypeWins[propType] =
            (propTypeWins[propType] || 0) + (outcome === "win" ? 1 : 0);
          propTypeLosses[propType] =
            (propTypeLosses[propType] || 0) + (outcome === "loss" ? 1 : 0);

          let streak, game_time;
          try {
            streak = await getStreaksForPlayer(player_id, propType);
            game_time = await getGameStartTimeET(gameId);
          } catch (e) {
            console.warn(
              `⚠️ Error fetching streak/time for ${fullName}, ${propType}`
            );
            continue;
          }

          if (!game_time) continue;
          const gameDateTimeET = toEasternDateTime(gameDate, game_time);

          const { data: existingRows, error: fetchErr } = await supabase
            .from("model_training_props")
            .select("id, prop_value, outcome")
            .eq("player_id", String(player_id))
            .eq("game_id", gameId)
            .eq("prop_type", propType)
            .eq("prop_source", "mlb_api")
            .limit(1);

          const existing = existingRows?.[0];
          if (fetchErr || !Array.isArray(existingRows)) {
            const errMsg =
              fetchErr?.message || typeof existingRows === "string"
                ? existingRows.slice(0, 100)
                : "Unknown Supabase error";
            console.warn(
              `⚠️ Fetch error for ${fullName}, ${propType}: ${errMsg}`
            );
            continue;
          }

          if (
            existing &&
            existing.prop_value != null &&
            existing.outcome != null
          )
            continue;

          const row = {
            id: crypto.randomUUID(),
            game_id: gameId,
            player_id: String(player_id),
            player_name: fullName,
            team,
            is_home: isHome ? 1 : 0,
            prop_type: propType,
            prop_value: result,
            line,
            over_under,
            outcome,
            status: "resolved",
            created_at: now,
            updated_at: now,
            prop_source: "mlb_api",
            was_correct,
            opponent,
            opponent_encoded,
            game_date: gameDate,
            game_day_of_week: getDayOfWeekET(gameDateTimeET),
            time_of_day_bucket: getTimeOfDayBucketET(gameDateTimeET),
            streak_type: streak?.streak_type ?? null,
            streak_count: streak?.streak_count ?? null,
            ...contextFields,
          };

          try {
            const { error } = await supabase
              .from("model_training_props")
              .upsert(row, {
                onConflict: [
                  "player_id",
                  "game_id",
                  "prop_type",
                  "prop_source",
                ],
              });

            if (!error) {
              inserted++;
              propTypeInsertCounts[propType] =
                (propTypeInsertCounts[propType] || 0) + 1;
              if (inserted % LOG_EVERY === 0)
                log(`   ↳ ${inserted} rows so far for ${gameDate}…`);
            } else {
              console.error(
                `❌ Upsert failed (${fullName}, ${propType}):`,
                error.message
              );
            }
          } catch (err) {
            console.error(
              `❌ Exception during upsert for ${fullName}, ${propType}:`,
              err
            );
          }
        }
      }

      log(`✅ Game ${gameId} finished — ${inserted} rows inserted`);
      await sleep(SLEEP_MS);
    } catch (err) {
      console.error(`❌ Crash during game ${gameId}:`, err);
    }
  }
}

(async () => {
  for (const d of datesToProcess) {
    try {
      await processDate(d);
    } catch (err) {
      console.error(`❌ Crash during processDate(${d}):`, err);
    }
  }

  try {
    forceLog("\n🎯 Over/Under Pick Distribution:");
    forceLog(`   ➕ Over:  ${overCount}`);
    forceLog(`   ➖ Under: ${underCount}`);

    forceLog("\n🏁 Final Outcome Totals:");
    forceLog(`   ✅ Wins:   ${winCount}`);
    forceLog(`   ❌ Losses: ${lossCount}`);

    forceLog("\n📊 Outcome by prop type:");

    log("\n📊 Prop type summary:");

    const allTypes = Array.from(
      new Set([
        ...Object.keys(propTypeInsertCounts),
        ...Object.keys(propTypeWins),
        ...Object.keys(propTypeLosses),
      ])
    );

    for (const type of allTypes.sort()) {
      const inserted = propTypeInsertCounts[type] || 0;
      const w = propTypeWins[type] || 0;
      const l = propTypeLosses[type] || 0;

      forceLog(
        `${type.padEnd(20)} ${String(inserted).padStart(4)} inserted | ${String(
          w
        ).padStart(3)}W / ${String(l).padStart(3)}L`
      );
    }

    forceLog("\n🏁 Script finished successfully.");
  } catch (err) {
    console.error("❌ Error in final summary block:", err.message);
    console.error("⚠️ Falling back to basic totals:");
    console.log({ overCount, underCount, winCount, lossCount });
  }
})().catch((err) => {
  console.error("❌ Top-level script crash:", err);
});
