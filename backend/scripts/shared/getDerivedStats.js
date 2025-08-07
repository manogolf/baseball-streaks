// ✅ Patched getDerivedStats.js with sourceMode

import {
  VALID_PROP_TYPES,
  extractStatForPropType,
  getRollingAverage,
} from "./propUtilsBackend.js";

export async function getDerivedStats(
  playerId,
  gameDate,
  gameId,
  cache, // could be boxscoreCache or playerGameHistory
  supabase,
  sourceMode = "boxscore" // or "history"
) {
  const rollingDays = [7, 15, 30];
  const result = {};
  const now = new Date(gameDate);

  const DEBUG_MODE = false; // Set to true when you want full logs

  //  console.log(
  //    `📊 Calculating derived stats for player ${playerId} on ${gameDate}`
  //  );

  if (!Array.isArray(VALID_PROP_TYPES) || VALID_PROP_TYPES.length === 0) {
    throw new Error("❌ VALID_PROP_TYPES is missing or empty");
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

        const fromDate = new Date(now);
        fromDate.setDate(now.getDate() - days);

        let total = 0;
        let count = 0;

        if (sourceMode === "boxscore") {
          if (!cache || typeof cache.entries !== "function") {
            console.warn(
              `⚠️ Boxscore cache missing or invalid for player ${playerId}, skipping boxscore fallback`
            );
            continue;
          }

          for (const [gamePk, box] of cache.entries()) {
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
        } else if (sourceMode === "history") {
          const history = cache.get(String(playerId)) || [];

          if (DEBUG_MODE)
            console.log(`🧪 [${playerId}] history length: ${history.length}`);

          for (const row of history) {
            if (DEBUG_MODE) {
              console.log(`🧾 [${playerId}] row:`, {
                game_date: row.game_date,
                prop_type: row.prop_type,
                prop_value: row.prop_value,
              });
            }

            const rowDate = new Date(row.game_date);
            const comparisonDate = new Date(gameDate);

            if (rowDate >= comparisonDate) {
              if (DEBUG_MODE)
                console.log(`⏩ Skipped by date: ${row.game_date}`);
              continue;
            }

            if (row.prop_type !== propType) {
              if (DEBUG_MODE) {
                console.log(
                  `⏩ Skipped by type: ${row.prop_type} !== ${propType}`
                );
              }
              continue;
            }

            if (typeof row.prop_value === "number" && !isNaN(row.prop_value)) {
              total += row.prop_value;
              count += 1;
            }
          }

          if (DEBUG_MODE) {
            console.log(`🧪 [${playerId}] fallback count: ${count}`);
          }

          if (count > 0) {
            result[key] = total / count;
            if (DEBUG_MODE) {
              console.log(`✅ Computed fallback avg for ${key}:`, result[key]);
            }
          } else {
            // console.warn(`⚠️ Fallback failed for ${key} — count = 0`);
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

  //  console.log(`✅ Derived stats for ${playerId} on ${gameDate}:`, result);
  //  return result;
}
