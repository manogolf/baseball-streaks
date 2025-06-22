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
  buildSyntheticLine,
  getSyntheticLine,
  getStaticFallbackLine,
} from "./shared/syntheticLineUtils.js";
import {
  getStreaksForPlayer,
  getBatterVsPitcherStats,
  getPitcherVsBatterStats,
} from "./shared/playerUtils.js";
import { fetchBoxscoreStatsForGame } from "./shared/fetchBoxscoreStats.js";
import { teamNameMap } from "./shared/teamNameMap.js";
import crypto from "node:crypto";

const START = "2024-03-28";
const END = "2024-10-01";
const LOG_EVERY = 150;
const SLEEP_MS = 10;

const propTypeWins = {};
const propTypeLosses = {};
let overCount = 0;
let underCount = 0;
let winCount = 0;
let lossCount = 0;

const quietMode = true;

// helper (keep it near top of file)
const isLocallyMeaningful = (obj) =>
  obj && (Number(obj.ab ?? obj.at_bats ?? 0) > 0 || Number(obj.pa ?? 0) > 0);

function dateRange(start, end) {
  const out = [];
  for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1))
    out.push(toISODate(d));
  return out;
}

const datesToProcess = dateRange(START, END);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

      // ── NEW: define role flags right after we have `stats`
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

      // ✅ Restore correct opponent handling

      // ────────────────────────────────────────────────────────────
      // 🎯  Trimmed and validated BvP / PvB logic
      // ────────────────────────────────────────────────────────────

      let bvpStats = {};
      let pvbStats = {};

      // Find the starting pitcher on the OTHER team
      const startingPitcher = allPlayers.find(
        (p) =>
          p.isHome !== isHome &&
          p.stats?.pitching &&
          p.stats.pitching.gamesStarted > 0
      );
      const startingPitcherId = startingPitcher?.id ?? null;

      /* ----------  BvP  ---------- */
      if (hasBat && startingPitcherId) {
        // 1️⃣ call resolver & log full object
        const resBvp = await resolveStatForPlayer({
          mode: "bvp",
          batter_id: player_id,
          pitcher_id: startingPitcherId,
        });
        //console.log("→ full BvP resolver response:", resBvp);

        const rawBvp = resBvp?.rawStats;
        //console.log("→ rawBvp:", rawBvp);

        const legacyBvp = !rawBvp
          ? await getBatterVsPitcherStats(player_id, startingPitcherId)
          : null;

        // 2️⃣ meaningful check
        // Always prefer the live raw block; fall back to legacy only if it’s missing
        const s = rawBvp ?? legacyBvp;
        //console.log("→ candidate BvP block (raw or legacy):", s);

        //console.log("🧪 final `s` selected for BvP:", s);

        if (s && hasMeaningfulStats(s)) {
          bvpStats = {
            bvp_ab: s.ab ?? s.at_bats ?? null,
            bvp_hits: s.hits ?? null,
            bvp_home_runs: s.home_runs ?? s.homeRuns ?? null,
            bvp_strikeouts: s.strikeouts ?? s.strike_outs ?? null,
            bvp_walks: s.walks ?? s.base_on_balls ?? null,
            bvp_avg: s.avg ?? null,
            // … (other fields you actually need)
          };
          //console.log(`✅ Assigned bvpStats for ${fullName}:`, bvpStats);
        } else {
          //console.log(`⚠️ No meaningful BvP stats for ${fullName}`);
        }
      }

      /* ----------  PvB  ---------- */
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
          const { rawStats: rawPvB } =
            (await resolveStatForPlayer({
              mode: "pvb",
              pitcher_id: player_id,
              batter_id: b.id,
            })) || {};

          const legacy = !rawPvB
            ? await getPitcherVsBatterStats(player_id, b.id)
            : null;

          const candidate = isLocallyMeaningful(rawPvB)
            ? rawPvB
            : isLocallyMeaningful(legacy)
            ? legacy
            : null;

          if (!candidate) continue;

          // Sum PvB into agg
          agg.ab += candidate.ab || candidate.at_bats || 0;
          agg.hits += candidate.hits || 0;
          agg.home_runs += candidate.home_runs || candidate.homeRuns || 0;
          agg.strikeouts += candidate.strikeouts || candidate.strike_outs || 0;
          agg.walks += candidate.walks || candidate.base_on_balls || 0;
          agg.pa += candidate.pa || 0;
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

          //console.log(`✅ Final PvB stats for ${fullName}:`, pvbStats);
        } else {
          //console.log(`⚠️ No aggregated PvB stats for ${fullName}`);
        }
      }
      for (const propType of VALID_PROP_TYPES) {
        const result = extractStatForPropType(propType, stats);
        if (result == null || typeof result !== "number" || isNaN(result)) {
          continue; // silently skip invalid result rows
        }

        // 🔍 NEW: Track what stats made it past the filter
        //console.log(`🧩 Prop: ${propType} → result: ${result}`);

        const line =
          (await getSyntheticLine(propType)) ??
          (await buildSyntheticLine(
            propType,
            player_id,
            getStaticFallbackLine
          ));

        const over_under = Math.random() > 0.5 ? "over" : "under";
        if (over_under === "over") overCount++;
        else underCount++;

        const outcome = determineOutcome(result, line, over_under);
        if (outcome === "win") winCount++;
        else lossCount++;

        propTypeWins[propType] =
          (propTypeWins[propType] || 0) + (outcome === "win" ? 1 : 0);
        propTypeLosses[propType] =
          (propTypeLosses[propType] || 0) + (outcome === "loss" ? 1 : 0);

        const streak = await getStreaksForPlayer(player_id, propType);

        if (!quietMode) {
          //console.log("📊 BvP Stats:", bvpStats);
          //console.log("📊 PvB Stats:", pvbStats);
        }

        // Combine game date + time and get Eastern DateTime object
        const game_time = await getGameStartTimeET(gameId);
        if (!game_time) {
          console.warn(`⚠️ No game_time found for game_id ${gameId}`);
          continue;
        }

        const gameDateTimeET = toEasternDateTime(gameDate, game_time);

        // Derive time of day and day of week in Eastern Time
        const time_of_day_bucket = getTimeOfDayBucketET(gameDateTimeET);
        const game_day_of_week = getDayOfWeekET(gameDateTimeET);

        const row = {
          id: crypto.randomUUID(),
          player_id: String(player_id),
          player_name: fullName,
          team,
          is_home: isHome ? 1 : 0,
          prop_type: propType,
          prop_value: result,
          result,
          over_under,
          outcome,
          status: "resolved",
          created_at: now,
          updated_at: now,
          prop_source: "mlb_api",
          game_id: gameId,
          opponent,
          opponent_encoded,
          game_date: gameDate,
          game_day_of_week,
          time_of_day_bucket,
          streak_type: streak?.streak_type ?? null,
          streak_count: streak?.streak_count ?? null,
          ...(bvpStats || {}),
          ...(pvbStats || {}),
          // d7_hits: getStat("d7", "hits"),
          // d7_home_runs: getStat("d7", "homeRuns"),
          // d7_rbis: getStat("d7", "rbi"),
          // d7_strikeouts: getStat("d7", "strikeOuts"),
          // d7_walks: getStat("d7", "baseOnBalls"),
          // d15_hits: getStat("d15", "hits"),
          // d15_home_runs: getStat("d15", "homeRuns"),
          // d15_rbis: getStat("d15", "rbi"),
          // d15_strikeouts: getStat("d15", "strikeOuts"),
          // d15_walks: getStat("d15", "baseOnBalls"),
          // d30_hits: getStat("d30", "hits"),
          // d30_home_runs: getStat("d30", "homeRuns"),
          // d30_rbis: getStat("d30", "rbi"),
          // d30_strikeouts: getStat("d30", "strikeOuts"),
          // d30_walks: getStat("d30", "baseOnBalls"),
        };

        // ░░ Optional or conditional fields ░░

        row.opponent = opponent;
        row.opponent_encoded = opponent_encoded;
        row.streak_type = streak?.streak_type;
        row.streak_count = streak?.streak_count;

        // BvP stats (batting vs pitcher)
        if (bvpStats) {
          for (const [k, v] of Object.entries(bvpStats)) {
            row[k] = v;
          }
        }

        // PvB stats (pitcher vs batting lineup)
        if (pvbStats) {
          for (const [k, v] of Object.entries(pvbStats)) {
            row[k] = v;
          }
        }

        // 🔍 Debug log: log BvP and PvB stats per player before upsert
        //console.log(
        //`\n📤 Prepared row for insert: ${row.player_name}, ${row.prop_type}`
        //);
        //console.log("   BvP Stats:", bvpStats);
        //console.log("   PvB Stats:", pvbStats);

        // Future stats can be re-enabled here:
        // safeAssign(row, "d7_hits", getStat("d7", "hits"));

        //console.log(
        //`📤 Final insert row for ${row.player_name}, ${row.prop_type}:`,
        //row
        //);

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
        console.log(`✅ Game ${gameId} finished — ${inserted} rows inserted`);
        await sleep(SLEEP_MS);
      }
    }
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
      `  ${type.padEnd(20)} ${String(w).padStart(2)}W / ${String(l).padStart(
        2
      )}L`
    );
  }
})();
