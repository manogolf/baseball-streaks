// 📄 File: backend/scripts/shared/getDerivedStats.js

import {
  VALID_PROP_TYPES,
  extractStatForPropType,
  getRollingAverage,
} from "./propUtilsBackend.js";

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

  console.log(
    `📊 Calculating derived stats for player ${playerId} on ${gameDate}`
  );

  if (!Array.isArray(VALID_PROP_TYPES) || VALID_PROP_TYPES.length === 0) {
    throw new Error(
      "❌ VALID_PROP_TYPES is missing or empty — check propUtils.js"
    );
  }

  for (const days of rollingDays) {
    for (const propType of VALID_PROP_TYPES) {
      const key = `d${days}_${propType}`;

      try {
        const avg = await getRollingAverage(
          supabase,
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

        console.warn(
          `⚠️ No rolling avg for player ${playerId}, prop ${propType}, d${days}`
        );

        // Fallback boxscore logic
        let total = 0;
        let count = 0;

        const fromDate = new Date(now);
        fromDate.setDate(now.getDate() - days);

        for (const [gamePk, box] of boxscoreCache.entries()) {
          const gameDateStr = box?.gameDate?.split("T")[0];
          if (!gameDateStr) continue;

          const boxDate = new Date(gameDateStr);
          if (boxDate < fromDate || boxDate > now) continue;

          // 🔒 Optional stricter filter
          // if (parseInt(gamePk) !== parseInt(gameId)) continue;

          const allPlayers = {
            ...box?.teams?.home?.players,
            ...box?.teams?.away?.players,
          };

          const player = Object.values(allPlayers).find(
            (p) => String(p?.person?.id) === String(playerId)
          );
          if (!player) continue;

          const isPitcher = !!player.stats?.pitching;
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
      } catch (err) {
        console.warn(`⚠️ Error in derived stat for ${key}: ${err.message}`);
      }
    }
  }
  console.log(`✅ Derived stats for ${playerId} on ${gameDate}:`, result);

  return result;
}
