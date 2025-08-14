// backend/scripts/insertStatDerivedProps.js
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
  toISODate,
  toEasternDateTime,
} from "./shared/timeUtilsBackend.js";
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

      if (!liveData?.gameData?.teams) {
        console.warn(`⚠️ liveData missing teams for game ${gameId}`);
        continue;
      }

      // define per-game team cache
      const homeTeam = liveData.gameData.teams.home ?? {};
      const awayTeam = liveData.gameData.teams.away ?? {};
      const TEAM = {
        home: {
          id: homeTeam.id ?? homeTeam.teamId ?? null,
          abbr: homeTeam.abbreviation ?? homeTeam.teamCode ?? null,
        },
        away: {
          id: awayTeam.id ?? awayTeam.teamId ?? null,
          abbr: awayTeam.abbreviation ?? awayTeam.teamCode ?? null,
        },
      };
      if (!Array.isArray(allPlayers)) {
        console.error(
          `❌ allPlayers for game ${gameId} is not an array:`,
          allPlayers
        );
        continue;
      }

      console.log(
        `🧾 Boxscore fetch: ${gameId} → ${allPlayers.length} players`
      );

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
      console.log(`📦 Fetched ${allPlayers.length} players for game ${gameId}`);
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
      // Build the player list we actually want to process
      const players = allPlayers.filter((p) => {
        const { batting = {}, pitching = {} } = p.stats || {};
        const hasBat = Object.keys(batting).length > 0;
        const hasPitch = Object.keys(pitching).length > 0;
        const position = positionMap.get(Number(p.id));
        const isPitch = isPitcher(position) || hasPitch; // include pitchers with stats
        return hasBat || isPitch;
      });

      log(`✅ Final player pool after filtering: ${players.length}`);
      log(`🔍 ${players.length} players to process`);

      let inserted = 0;

      for (const pl of players) {
        const {
          id: player_id,
          fullName,
          teamAbbr: teamAbbrRaw,
          isHome,
          stats,
        } = pl;

        // position lookup for pitcher/batter flags
        const position = positionMap.get(Number(player_id)) || null;

        // derive team ids/abbrs from per-game TEAM cache
        const teamId = isHome ? TEAM.home.id : TEAM.away.id;
        const opponentId = isHome ? TEAM.away.id : TEAM.home.id;
        const teamAbbr =
          (isHome ? TEAM.home.abbr : TEAM.away.abbr) ?? teamAbbrRaw ?? null;
        const opponentAbbr = isHome ? TEAM.away.abbr : TEAM.home.abbr;

        // keep opponent_encoded for back-compat (prefer IDs when present)
        const opponent_encoded =
          opponentId != null
            ? String(opponentId)
            : opponentAbbr
            ? getTeamIdFromAbbr(opponentAbbr)
            : null;

        const hasBat = !!(
          stats?.batting && Object.keys(stats.batting).length > 0
        );
        const hasPitch = !!(
          stats?.pitching && Object.keys(stats.pitching).length > 0
        );
        const isPitch = isPitcher(position) || hasPitch;
        const isBatterOnly = hasBat && !isPitch;
        const isPitcherOnly = isPitch && !hasBat;
        const isTwoWayPlayer = hasBat && isPitch;

        // cache game context by (game, teamAbbr)
        const contextKey = `${gameId}_${teamAbbr}`;
        let contextFields = teamContextCache.get(contextKey);
        if (!contextFields) {
          contextFields = await getGameContextFields(gameId, teamAbbr);
          teamContextCache.set(contextKey, contextFields);
        }

        forceLog(
          `🔍 ${fullName} (${player_id}) | ${teamAbbr} vs ${opponentAbbr} (${
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

        console.log(
          "📦 Full stats object for",
          fullName,
          JSON.stringify(stats, null, 2)
        );

        // Build eligible prop types from actual stat presence
        let eligiblePropTypes = [];
        if (hasBat) eligiblePropTypes.push(...BATTER_PROP_TYPES);
        if (isPitch) eligiblePropTypes.push(...PITCHER_PROP_TYPES);
        eligiblePropTypes = [...new Set(eligiblePropTypes)]; // de-dupe

        forceLog(`🔁 eligiblePropTypes: ${JSON.stringify(eligiblePropTypes)}`);

        // Optional diagnostics for pitchers with numeric stats
        if ((isPitcherOnly || isTwoWayPlayer) && verbose) {
          const seen = [];
          for (const pType of PITCHER_PROP_TYPES) {
            const v = extractStatForPropType(stats, pType);
            if (Number.isFinite(v)) seen.push(pType);
          }
          if (seen.length === 0) {
            console.warn(
              `⚠️ No pitcher stats extracted for ${fullName} (${player_id}). ` +
                `pitching keys: ${Object.keys(stats?.pitching || {}).join(",")}`
            );
          } else {
            console.log(
              `✅ Pitcher props with numeric values: ${seen.join(", ")}`
            );
          }
        }

        for (const propType of eligiblePropTypes) {
          // ratio sampling applies to ALL batter props (two-way included)
          if (
            isBatterProp(propType) &&
            !shouldInclude(player_id, gameId, propType)
          ) {
            continue;
          }

          if (typeof propType !== "string") {
            console.error(`❌ Invalid propType (not a string):`, propType);
            continue;
          }

          forceLog(
            `🧪 Calling extractStatForPropType with: propType=${JSON.stringify(
              propType
            )} (${typeof propType})`
          );

          const result = extractStatForPropType(stats, propType);
          forceLog(
            `🔍 Raw stat extraction for ${fullName} | ${propType} → ${result}`
          );

          if (!Number.isFinite(result)) {
            forceLog(
              `🟡 No valid result for ${fullName} (${player_id}) | ${propType}`
            );
            continue;
          }

          // create a half-step line (avoid pushes)
          let line =
            result === 0
              ? 0.5
              : Math.random() < 0.5
              ? result - 0.5
              : result + 0.5;
          line = Math.round(line * 2) / 2;

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

          // streak + game time
          let streak, game_time;
          try {
            streak = await getStreaksForPlayer(
              supabase,
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
          // Prefer full ISO-with-offset if provided by MLB; otherwise fall back
          let gameDateTimeET;
          if (typeof game_time === "string" && game_time.includes("T")) {
            const dt = new Date(game_time); // ISO with offset → valid Date
            if (!Number.isNaN(dt.getTime())) {
              gameDateTimeET = dt;
            }
          }
          if (!gameDateTimeET) {
            // Legacy path: when game_time is just "HH:mm:ss" or similar
            gameDateTimeET = toEasternDateTime(gameDate, game_time);
          }

          // check existing
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
              fetchErr?.message ||
              (typeof existingRows === "string"
                ? existingRows.slice(0, 100)
                : "Unknown Supabase error");
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
          if (!contextFields) {
            forceLog(`⚠️ contextFields missing for ${team} in game ${gameId}`);
          }

          const row = {
            id: crypto.randomUUID(),
            game_id: gameId,
            player_id: String(player_id),
            player_name: fullName,

            // display/back-compat
            team: teamAbbr,
            opponent: opponentAbbr,

            // canonical ids used by MT
            team_id: teamId != null ? String(teamId) : null,
            opponent_team_id: opponentId != null ? String(opponentId) : null,

            // legacy helper (safe to keep)
            opponent_encoded,

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

            game_date: gameDate,
            ...contextFields,
            game_day_of_week: getDayOfWeekET(gameDateTimeET),
            time_of_day_bucket: getTimeOfDayBucketET(gameDateTimeET),
            streak_type: streak?.streak_type ?? null,
            streak_count: streak?.streak_count ?? null,
          };

          forceLog(`📥 Attempting insert: ${JSON.stringify(row, null, 2)}`);

          try {
            const { error } = await supabase
              .from("model_training_props")
              .upsert(row, {
                onConflict: "player_id,game_id,prop_type,prop_source",
              }); // v2 format
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
        } // end for propType
      } // end for players

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
