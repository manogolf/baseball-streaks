// 📄 File: backend/scripts/shared/getDerivedStats.js
import fetch from "node-fetch";
import { toISODate } from "./timeUtils.js";

/**
 * Fetches and aggregates player stat totals over the past 7, 15, and 30 days.
 *
 * @param {string|number} playerId - MLB player ID
 * @param {string} gameDate - ISO date of the current game
 * @returns {Promise<Object>} Aggregated stats like d7_hits, d15_rbi, etc.
 */
export async function getDerivedStats(playerId, gameDate) {
  const rollingDays = [7, 15, 30];
  const statFields = ["hits", "homeRuns", "rbi", "strikeOuts", "baseOnBalls"];

  const results = {};
  const now = new Date(gameDate);

  for (const days of rollingDays) {
    const fromDate = new Date(now);
    fromDate.setDate(now.getDate() - days);
    const fromISO = toISODate(fromDate);
    const toISO = toISODate(now);

    // MLB API doesn't support true range stats, so we loop day-by-day
    for (let d = new Date(fromDate); d <= now; d.setDate(d.getDate() + 1)) {
      const dISO = toISODate(d);
      const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dISO}`;
      const schedRes = await fetch(schedUrl)
        .then((r) => r.json())
        .catch(() => null);
      const gameIds = (schedRes?.dates?.[0]?.games || []).map((g) => g.gamePk);

      for (const gamePk of gameIds) {
        const boxUrl = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
        const boxRes = await fetch(boxUrl)
          .then((r) => r.json())
          .catch(() => null);
        if (!boxRes) continue;

        const allPlayers = {
          ...boxRes.teams?.home?.players,
          ...boxRes.teams?.away?.players,
        };

        const match = Object.values(allPlayers).find(
          (p) => String(p?.person?.id) === String(playerId)
        );
        if (!match) continue;

        const stat = match.stats?.batting || match.stats?.pitching;
        if (!stat) continue;

        for (const field of statFields) {
          const key = `d${days}_${field}`;
          const val = parseInt(stat[field] ?? 0);
          results[key] = (results[key] || 0) + val;
        }
      }
    }
  }

  return results;
}
