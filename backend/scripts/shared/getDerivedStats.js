// 📄 File: backend/scripts/shared/getDerivedStats.js

import { toISODate } from "./timeUtils.js";
import {
  VALID_PROP_TYPES,
  extractStatForPropType,
  getRollingAverage,
} from "./propUtils.js";

/**
 * Computes rolling stats (d7/d15/d30) per prop type for a player
 * using getRollingAverage() with fallback to boxscore scan.
 *
 * @param {string|number} playerId - MLB player ID
 * @param {string} gameDate - ISO date string (yyyy-mm-dd)
 * @param {number} gameId - Game ID (not used here but kept for compatibility)
 * @param {Map<number, Object>} boxscoreCache - Preloaded gamePk → boxscore
 * @returns {Promise<Object>} e.g. { d7_hits: 2.3, d15_hits: 2.1, ... }
 */
export async function getDerivedStats(
  playerId,
  gameDate,
  gameId,
  boxscoreCache
) {
  const rollingDays = [7, 15, 30];
  const result = {};
  const now = new Date(gameDate);

  for (const days of rollingDays) {
    for (const propType of VALID_PROP_TYPES) {
      const key = `d${days}_${propType}`;

      // Primary source: rolling average
      const avg = await getRollingAverage(
        playerId,
        propType,
        gameDate,
        null,
        days
      );

      if (avg !== null && !isNaN(avg)) {
        result[key] = avg;
        continue;
      }

      // Fallback if rolling average fails
      let total = 0;
      let count = 0;

      const fromDate = new Date(now);
      fromDate.setDate(now.getDate() - days);

      for (const [gamePk, box] of boxscoreCache.entries()) {
        const gameDateStr = box?.gameDate?.split("T")[0];
        if (!gameDateStr) continue;

        const boxDate = new Date(gameDateStr);
        if (boxDate < fromDate || boxDate > now) continue;

        const allPlayers = {
          ...box?.teams?.home?.players,
          ...box?.teams?.away?.players,
        };

        const player = Object.values(allPlayers).find(
          (p) => String(p?.person?.id) === String(playerId)
        );
        if (!player) continue;

        const isPitcher =
          !!player.stats?.pitching &&
          Object.keys(player.stats.pitching || {}).length > 0;

        const statBlock =
          isPitcher && propType.includes("pitching")
            ? player.stats.pitching
            : player.stats.batting;

        const val = extractStatForPropType(propType, statBlock);
        if (typeof val === "number" && !isNaN(val)) {
          total += val;
          count += 1;
        }
      }

      if (count > 0) {
        result[key] = total / count;
      }
    }
  }

  return result;
}
