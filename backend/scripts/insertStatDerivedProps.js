// backend/scripts/insertStatDerivedProps.js
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
  toISODate,
  toEasternDateTime,
} from "./shared/timeUtils.js";
import {
  resolveStatForPlayer,
  hasMeaningfulStats,
} from "./resolution/statResolvers.js";
import { supabase } from "./shared/supabaseUtils.js";
import {
  extractStatForPropType,
  VALID_PROP_TYPES,
  determineOutcome,
} from "./shared/propUtils.js";
import {
  getStreaksForPlayer,
  getBatterVsPitcherStats,
  getPitcherVsBatterStats,
} from "./shared/playerUtils.js";
import { fetchBoxscoreStatsForGame } from "./shared/fetchBoxscoreStats.js";
import { teamNameMap } from "./shared/teamNameMap.js";
import crypto from "node:crypto";

const DAYS_AGO = 7; // or any number you want
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

const isLocallyMeaningful = (obj) =>
  obj && (Number(obj.ab ?? obj.at_bats ?? 0) > 0 || Number(obj.pa ?? 0) > 0);

async function processDate(gameDate) {
  console.log(`\n📅 ${gameDate}`);
  const schedURL = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}`;
  const schedRes = await fetch(schedURL)
    .then((r) => r.json())
    .catch(() => null);
  const gameIds = (schedRes?.dates?.[0]?.games || [])
    .filter((g) => g.status?.detailedState === "Final")
    .map((g) => g.gamePk);

  for (const gameId of gameIds) {
    console.log(`📍  Game ${gameId}`);
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

    console.log(`🔍 ${players.length} players to process`);
    let inserted = 0;

    for (const pl of players) {
      const { id: player_id, fullName, teamAbbr: team, isHome, stats } = pl;

      const hasBat = stats?.batting && Object.keys(stats.batting).length > 0;
      const isPitcher = stats?.pitching && stats.pitching.gamesStarted > 0;

      const opponentTeam = isHome
        ? allPlayers.find((p) => !p.isHome)
        : allPlayers.find((p) => p.isHome);

      const opponent = opponentTeam?.teamAbbr || null;
      const opponent_encoded =
        opponent in teamNameMap
          ? Object.keys(teamNameMap).indexOf(opponent)
          : null;

      const now = new Date().toISOString();

      // ── BvP and PvB STATS
      let bvpStats = {};
      let pvbStats = {};
      const startingPitcher = allPlayers.find(
        (p) => p.isHome !== isHome && p.stats?.pitching?.gamesStarted > 0
      );
      const startingPitcherId = startingPitcher?.id ?? null;

      if (hasBat && startingPitcherId) {
        const resBvp = await resolveStatForPlayer({
          mode: "bvp",
          batter_id: player_id,
          pitcher_id: startingPitcherId,
        });
        const s =
          resBvp?.rawStats ??
          (await getBatterVsPitcherStats(player_id, startingPitcherId));
        if (s && hasMeaningfulStats(s)) {
          bvpStats = {
            bvp_ab: s.ab ?? s.at_bats ?? null,
            bvp_hits: s.hits ?? null,
            bvp_home_runs: s.home_runs ?? s.homeRuns ?? null,
            bvp_strikeouts: s.strikeouts ?? s.strike_outs ?? null,
            bvp_walks: s.walks ?? s.base_on_balls ?? null,
            bvp_avg: s.avg ?? null,
          };
        }
      }

      if (isPitcher) {
        const bats = allPlayers.filter(
          (p) => p.isHome !== isHome && p.stats?.batting
        );
        const agg = {
          ab: 0,
          hits: 0,
          home_runs: 0,
          strikeouts: 0,
          walks: 0,
          pa: 0,
        };
        for (const b of bats) {
          const raw = (
            await resolveStatForPlayer({
              mode: "pvb",
              pitcher_id: player_id,
              batter_id: b.id,
            })
          )?.rawStats;
          const legacy = raw
            ? null
            : await getPitcherVsBatterStats(player_id, b.id);
          const s = isLocallyMeaningful(raw)
            ? raw
            : isLocallyMeaningful(legacy)
            ? legacy
            : null;
          if (!s) continue;
          agg.ab += s.ab || s.at_bats || 0;
          agg.hits += s.hits || 0;
          agg.home_runs += s.home_runs || s.homeRuns || 0;
          agg.strikeouts += s.strikeouts || s.strike_outs || 0;
          agg.walks += s.walks || s.base_on_balls || 0;
          agg.pa += s.pa || 0;
        }
        if (agg.ab > 0) {
          pvbStats = {
            pvb_ab: agg.ab,
            pvb_hits: agg.hits,
            pvb_home_runs: agg.home_runs,
            pvb_strikeouts: agg.strikeouts,
            pvb_walks: agg.walks,
            pvb_avg: +(agg.hits / agg.ab).toFixed(3),
            pvb_plate_appearances: agg.pa,
          };
        }
      }

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

        const row = {
          id: crypto.randomUUID(),
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
          ...(bvpStats || {}),
          ...(pvbStats || {}),
        };

        const { error } = await supabase
          .from("model_training_props")
          .upsert(row, {
            onConflict: ["player_id", "game_id", "prop_type", "prop_source"],
          });

        if (!error) {
          inserted++;
          if (inserted % LOG_EVERY === 0)
            console.log(`   ↳ ${inserted} rows so far for ${gameDate}…`);
        } else {
          console.error(
            `❌ Upsert failed (${fullName}, ${propType}):`,
            error.message
          );
        }
      }
    }
    console.log(`✅ Game ${gameId} finished — ${inserted} rows inserted`);
    await sleep(SLEEP_MS);
  }
}

(async () => {
  for (const d of datesToProcess) {
    await processDate(d);
  }

  console.log("\n🎯 Over/Under Pick Distribution:");
  console.log(`   ➕ Over:  ${overCount}`);
  console.log(`   ➖ Under: ${underCount}`);
  console.log("\n🏁 Final Outcome Totals:");
  console.log(`   ✅ Wins:   ${winCount}`);
  console.log(`   ❌ Losses: ${lossCount}`);
  console.log("\n📊 Outcome by prop type:");
  for (const type of Object.keys({
    ...propTypeWins,
    ...propTypeLosses,
  }).sort()) {
    const w = propTypeWins[type] || 0;
    const l = propTypeLosses[type] || 0;
    console.log(
      `${type.padEnd(20)} ${String(w).padStart(2)}W / ${String(l).padStart(2)}L`
    );
  }
})();
