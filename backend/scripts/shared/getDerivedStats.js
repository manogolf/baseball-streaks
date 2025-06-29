// 📄 File: backend/scripts/shared/getDerivedStats.js

import fetch from "node-fetch";
import { toISODate } from "./timeUtils.js";
import {
  VALID_PROP_TYPES,
  extractStatForPropType,
  getRollingAverage,
} from "./propUtils.js"; // Assumes this exists for stat resolution

/**
 * Aggregates player prop stats (d7/d15/d30) using cached boxscore data.
 *
 * @param {string|number} playerId - MLB player ID
 * @param {string} gameDate - ISO date of the current game
 * @returns {Promise<Object>} - { d7_hits, d15_total_bases, ... }
 */

const propTypes = VALID_PROP_TYPES;

export async function getDerivedStats(playerId, gameDate, gameId) {
  const rollingDays = [7, 15, 30];

  const results = {};
  const now = new Date(gameDate);
  const boxscoreCache = new Map();

  for (const days of rollingDays) {
    const fromDate = new Date(now);
    fromDate.setDate(now.getDate() - days);

    for (let d = new Date(fromDate); d <= now; d.setDate(d.getDate() + 1)) {
      const dISO = toISODate(d);
      const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dISO}`;
      const schedRes = await fetch(schedUrl)
        .then((r) => r.json())
        .catch(() => null);
      const gameIds = (schedRes?.dates?.[0]?.games || []).map((g) => g.gamePk);

      for (const gamePk of gameIds) {
        if (!boxscoreCache.has(gamePk)) {
          const boxUrl = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
          const boxRes = await fetch(boxUrl)
            .then((r) => r.json())
            .catch(() => null);
          if (!boxRes) continue;
          boxscoreCache.set(gamePk, boxRes);
        }

        const box = boxscoreCache.get(gamePk);
        const allPlayers = {
          ...box?.teams?.home?.players,
          ...box?.teams?.away?.players,
        };
        const match = Object.values(allPlayers).find(
          (p) => String(p?.person?.id) === String(playerId)
        );
        if (!match) continue;

        if (!match.stats?.batting && !match.stats?.pitching) {
          console.log(
            `🟡 No batting or pitching stats for player ${playerId} on ${dISO}`
          );
          continue;
        }

        //console.log(`📦 Stats for player ${playerId} on ${dISO}:`, match.stats);

        const isPitcher =
          !!match.stats?.pitching &&
          Object.keys(match.stats.pitching).length > 0;

        const batterOnlyProps = [
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
        ];

        const pitcherOnlyProps = [
          "strikeouts_pitching",
          "walks_allowed",
          "earned_runs",
          "hits_allowed",
          "outs_recorded",
        ];

        for (const propType of propTypes) {
          const isPitcherStat = pitcherOnlyProps.includes(propType);
          const isBatterStat = batterOnlyProps.includes(propType);

          if (isPitcherStat && !isPitcher) continue;
          if (isBatterStat && isPitcher) continue;

          const key = `d${days}_${propType}`;

          const rollingAvg = await getRollingAverage(
            playerId,
            propType,
            gameDate,
            gameId,
            days
          );

          if (rollingAvg !== null) {
            results[key] = rollingAvg;
          } else {
            const val = extractStatForPropType(
              propType,
              isPitcher ? match.stats?.pitching : match.stats?.batting
            );
            if (typeof val === "number" && !isNaN(val)) {
              results[key] = (results[key] || 0) + val;
            } else {
              console.log(
                `⚠️ Skipping ${propType} on ${dISO} — not a number:`,
                val
              );
            }
          }
        }
      }
    }
  }

  return results;
}
