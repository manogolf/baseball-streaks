// backend/scripts/insertStatDerivedProps.js
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
  toISODate,
  toEasternDateTime,
} from "./shared/timeUtils.js";
import { supabase } from "./shared/supabaseUtils.js";
import {
  extractStatForPropType,
  VALID_PROP_TYPES,
  determineOutcome,
} from "./shared/propUtils.js";
import { getStreaksForPlayer } from "./shared/playerUtils.js";
import { fetchBoxscoreStatsForGame } from "./shared/fetchBoxscoreStats.js";
import {
  getGameContextFields,
  getLiveFeedFromGameID,
} from "./shared/mlbApiUtils.js";
import { getTeamIdFromAbbr } from "./shared/teamNameMap.js";
import crypto from "node:crypto";

const verbose = process.argv.includes("--verbose");
const log = (...args) => verbose && console.log(...args);

const DAYS_AGO = 2; // or any number you want
const today = new Date();
const endDate = new Date(today);
endDate.setDate(endDate.getDate() - 1); // yesterday

const startDate = new Date(today);
startDate.setDate(startDate.getDate() - DAYS_AGO); // DAYS_AGO ago

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

const quietMode = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processDate(gameDate) {
  log(`\n📅 ${gameDate}`);
  const schedURL = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}`;
  const schedRes = await fetch(schedURL)
    .then((r) => r.json())
    .catch(() => null);
  const gameIds = (schedRes?.dates?.[0]?.games || [])
    .filter((g) => g.status?.detailedState === "Final")
    .map((g) => g.gamePk);

  const teamContextCache = new Map(); // key: `${gameId}_${team}`

  for (const gameId of gameIds) {
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

      // ── PER-PROP INSERTION
      let eligiblePropTypes = [];

      if (hasBat) {
        eligiblePropTypes.push(
          "hits",
          "doubles",
          "triples",
          "home_runs",
          "rbis",
          "runs_scored",
          "strikeouts_batting",
          "walks",
          "stolen_bases",
          "total_bases",
          "hits_runs_rbis",
          "runs_rbis",
          "singles"
        );
      }

      if (isPitcher) {
        eligiblePropTypes.push(
          "strikeouts_pitching",
          "outs_recorded",
          "walks_allowed",
          "hits_allowed",
          "earned_runs"
        );
      }

      for (const propType of eligiblePropTypes) {
        const result = extractStatForPropType(propType, stats);
        if (result == null || typeof result !== "number" || isNaN(result))
          continue;

        // ✅ Step 1: Create a .5-offset line so no push is possible
        const line = Math.random() < 0.5 ? result + 0.5 : result - 0.5;

        // ✅ Step 2: Randomly pick over or under
        const over_under = Math.random() < 0.5 ? "over" : "under";

        // ✅ Step 3: Grade outcome using real function
        const outcome = determineOutcome(result, line, over_under);

        // ❌ Skip invalid outcomes
        if (!["win", "loss"].includes(outcome)) continue;

        const was_correct = outcome === "win";

        // Optional tracking
        if (over_under === "over") overCount++;
        else if (over_under === "under") underCount++;

        if (outcome === "win") winCount++;
        else if (outcome === "loss") lossCount++;

        propTypeWins[propType] =
          (propTypeWins[propType] || 0) + (outcome === "win" ? 1 : 0);
        propTypeLosses[propType] =
          (propTypeLosses[propType] || 0) + (outcome === "loss" ? 1 : 0);

        const streak = await getStreaksForPlayer(player_id, propType);
        const game_time = await getGameStartTimeET(gameId);
        if (!game_time) continue;
        const gameDateTimeET = toEasternDateTime(gameDate, game_time);

        // 🛡️ Prevent overwriting existing derived data
        const { data: existingRows, error: fetchErr } = await supabase
          .from("model_training_props")
          .select("id, prop_value, outcome")
          .eq("player_id", String(player_id))
          .eq("game_id", gameId)
          .eq("prop_type", propType)
          .eq("prop_source", "mlb_api")
          .maybeSingle();

        if (fetchErr) {
          console.warn(
            `⚠️ Fetch error for ${fullName}, ${propType}:`,
            fetchErr.message
          );
        } else if (
          existingRows &&
          existingRows.prop_value != null &&
          existingRows.outcome != null
        ) {
          if (!quietMode) {
            log(
              `⏭️ Skipping existing derived prop for ${fullName} | ${propType}`
            );
          }
          continue; // ✅ Skip this insert
        }

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
          game_id: gameId,
          opponent,
          opponent_encoded,
          game_date: gameDate,
          game_day_of_week: getDayOfWeekET(gameDateTimeET),
          time_of_day_bucket: getTimeOfDayBucketET(gameDateTimeET),
          streak_type: streak?.streak_type ?? null,
          streak_count: streak?.streak_count ?? null,
          ...contextFields,
        };

        const { error } = await supabase
          .from("model_training_props")
          .upsert(row, {
            onConflict: ["player_id", "game_id", "prop_type", "prop_source"],
          });

        if (!error) {
          inserted++;
          if (inserted % LOG_EVERY === 0)
            log(`   ↳ ${inserted} rows so far for ${gameDate}…`);
        } else {
          console.error(
            `❌ Upsert failed (${fullName}, ${propType}):`,
            error.message
          );
        }
      }
    }
    log(`✅ Game ${gameId} finished — ${inserted} rows inserted`);
    await sleep(SLEEP_MS);
  }
}

(async () => {
  for (const d of datesToProcess) {
    await processDate(d);
  }

  log("\n🎯 Over/Under Pick Distribution:");
  log(`   ➕ Over:  ${overCount}`);
  log(`   ➖ Under: ${underCount}`);
  log("\n🏁 Final Outcome Totals:");
  log(`   ✅ Wins:   ${winCount}`);
  log(`   ❌ Losses: ${lossCount}`);
  log("\n📊 Outcome by prop type:");
  for (const type of Object.keys({
    ...propTypeWins,
    ...propTypeLosses,
  }).sort()) {
    const w = propTypeWins[type] || 0;
    const l = propTypeLosses[type] || 0;
    log(
      `${type.padEnd(20)} ${String(w).padStart(2)}W / ${String(l).padStart(2)}L`
    );
  }
})();
