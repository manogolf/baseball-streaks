// backend/scripts/insertStatDerivedProps.js
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
  toISODate,
  toEasternDateTime,
} from "../../shared/timeUtils.js";
import { supabase } from "./shared/supabaseBackend.js";
import {
  BATTER_PROP_TYPES,
  PITCHER_PROP_TYPES,
  isBatterProp,
  determineOutcome,
} from "../../shared/propUtils.js";
import {
  getStreaksForPlayer,
  getPlayerPositionMap,
  isPitcher,
} from "./shared/playerUtilsBackend.js";
import { fetchBoxscoreStatsForGame } from "./shared/fetchBoxscoreStats.js";
import {
  getGameContextFields,
  getLiveFeedFromGameID,
} from "./shared/mlbApiUtils.js";
import { getTeamIdFromAbbr } from "../../shared/teamNameMap.js";
import { extractStatForPropType } from "./shared/propUtilsBackend.js";
import crypto from "node:crypto";

console.log(
  "BATTER_PROP_TYPES:",
  BATTER_PROP_TYPES.map((p) => typeof p)
);
console.log(
  "PITCHER_PROP_TYPES:",
  PITCHER_PROP_TYPES.map((p) => typeof p)
);

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
  const positionMap = await getPlayerPositionMap(gameDate);

  for (const gameId of gameIds) {
    try {
      log(`📍  Game ${gameId}`);
      const liveData = await getLiveFeedFromGameID(gameId);
      const allPlays = liveData?.liveData?.plays?.allPlays || [];
      const allPlayers = await fetchBoxscoreStatsForGame(gameId);
      if (!Array.isArray(allPlayers)) {
        console.error(
          `❌ allPlayers for game ${gameId} is not an array:`,
          allPlayers
        );
        continue;
      }

      if (allPlayers.some((p) => !p || typeof p !== "object" || !("id" in p))) {
        console.error(
          `❌ Invalid player object found in allPlayers for game ${gameId}`
        );
        for (const bad of allPlayers.filter(
          (p) => !p || typeof p !== "object" || !("id" in p)
        )) {
          console.error("👉 Bad player:", bad);
        }
        continue;
      }

      if (!allPlayers) continue;

      // 🔍 Diagnostic print of all players' stat keys
      // Log a summary of player stat availability before filtering
      for (const p of allPlayers) {
        const batKeys = Object.keys(p.stats?.batting || []).join(", ");
        const pitchKeys = Object.keys(p.stats?.pitching || []).join(", ");

        if (!batKeys && !pitchKeys) {
          console.warn(`⚠️ No stats found for ${p.fullName} (${p.id})`);
        } else {
          forceLog(
            `📊 ${p.fullName} (${p.id}) → Batting: [${batKeys}] | Pitching: [${pitchKeys}]`
          );
        }
      }

      // Filter players we want to evaluate
      const players = allPlayers.filter((p) => {
        const { batting = {}, pitching = {} } = p.stats || {};
        const hasBat = Object.keys(batting).length > 0;
        const position = positionMap.get(Number(p.id));
        const isPitch = isPitcher(position);
        return hasBat || isPitch;
      });

      log(`✅ Final player pool after filtering: ${players.length}`);
      log(`🔍 ${players.length} players to process`);

      let inserted = 0;

      for (const pl of players) {
        const { id: player_id, fullName, teamAbbr: team, isHome, stats } = pl;
        const position = positionMap.get(Number(player_id)) || null;
        const isPitch = isPitcher(position);
        const hasBat = stats?.batting && Object.keys(stats.batting).length > 0;
        const isBatterOnly = hasBat && !isPitch;
        const isPitcherOnly = isPitch && !hasBat;
        const isTwoWayPlayer = hasBat && isPitch;

        const opponentTeam = isHome
          ? allPlayers.find((p) => !p.isHome)
          : allPlayers.find((p) => p.isHome);
        const opponent = opponentTeam?.teamAbbr || null;
        const opponent_encoded = getTeamIdFromAbbr(opponent);
        const contextKey = `${gameId}_${team}`;
        let contextFields;

        // Focused logs per player — only once, clean and readable
        forceLog(
          `🔍 ${fullName} (${player_id}) | ${team} vs ${opponent} (${
            isHome ? "home" : "away"
          })`
        );
        forceLog(
          `📌 Position: ${position} | Pitcher: ${isPitch} | Batter: ${hasBat} | Role: ${[
            isBatterOnly && "batter",
            isPitcherOnly && "pitcher",
            isTwoWayPlayer && "two-way",
          ]
            .filter(Boolean)
            .join(", ")}`
        );

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

        forceLog(`🔁 eligiblePropTypes: ${JSON.stringify(eligiblePropTypes)}`);

        for (const propType of eligiblePropTypes) {
          if (isBatterOnly && isBatterProp(propType)) {
            if (!shouldInclude(player_id, gameId, propType)) continue;
          }

          if (typeof propType !== "string") {
            console.error(`❌ Invalid propType (not a string):`, propType);
            continue;
          }

          forceLog(
            `🔁 eligiblePropTypes: ${JSON.stringify(eligiblePropTypes)}`
          );
          forceLog(
            `🧪 Calling extractStatForPropType with: propType=${JSON.stringify(
              propType
            )} (${typeof propType})`
          );

          const result = extractStatForPropType(propType, stats); // ✅ correct
          console.log(
            "🧪 [extractStat] raw propType:",
            propType,
            "| type:",
            typeof propType
          );

          forceLog(
            `🔍 Raw stat extraction for ${fullName} | ${propType} → ${result}`
          );
          if (result == null || typeof result !== "number" || isNaN(result)) {
            forceLog(
              `🟡 No valid result for ${fullName} (${player_id}) | ${propType}`
            );
            continue;
          }
          forceLog(
            `🧪 Testing insert for ${fullName} | ${propType} | result=${result}`
          );

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
            streak = await getStreaksForPlayer(
              supabase,
              player_id,
              propType,
              "mlb_api"
            );
            console.log(
              "🧪 Calling getStreaksForPlayer with:",
              player_id,
              propType,
              "mlb_api"
            );

            game_time = await getGameStartTimeET(gameId);
          } catch (e) {
            console.warn(
              `⚠️ Error fetching streak/time for ${fullName}, ${propType}`
            );
            continue;
          }

          if (!game_time) continue;
          const gameDateTimeET = toEasternDateTime(gameDate, game_time);

          forceLog(
            `📥 Checking existing MT row for ${fullName} (${player_id}) | ${gameId} | ${propType}`
          );

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
          ) {
            forceLog(
              `📭 Existing row found: prop_value=${existing.prop_value}, outcome=${existing.outcome}`
            );
            continue;
          }
          if (!contextFields)
            forceLog(`⚠️ contextFields missing for ${team} in game ${gameId}`);

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

          forceLog(`📥 Attempting insert: ${JSON.stringify(row, null, 2)}`);

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
              log(
                `📊 Count updated for ${propType} (${propTypeInsertCounts[propType]} total)`
              );

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
