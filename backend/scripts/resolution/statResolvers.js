// statResolvers.js

import { getStatFromLiveFeed } from "./getStatFromLiveFeed.js";
import {
  flattenPlayerBoxscore,
  getPlayerStatsFromBoxscore,
  getBatterVsPitcherStats,
  getPitcherVsBatterStats,
} from "../shared/playerUtils.js";
import { derivePropValue } from "./derivePropValue.js";

/**
 * Resolves a stat value using boxscore first, then allPlays as fallback.
 */

export function hasMeaningfulStats(stats) {
  if (!stats || typeof stats !== "object") return false;

  const { batting = {}, pitching = {} } = stats;

  const hasBatting =
    typeof batting.hits === "number" ||
    typeof batting.runs === "number" ||
    typeof batting.rbi === "number" ||
    typeof batting.totalBases === "number" ||
    typeof batting.baseOnBalls === "number" ||
    typeof batting.strikeOuts === "number" ||
    typeof batting.homeRuns === "number" ||
    typeof batting.doubles === "number" ||
    typeof batting.triples === "number" ||
    typeof batting.stolenBases === "number";

  const hasPitching =
    typeof pitching.strikeOuts === "number" ||
    typeof pitching.baseOnBalls === "number" ||
    typeof pitching.hits === "number" ||
    typeof pitching.earnedRuns === "number" ||
    typeof pitching.outs === "number";

  return hasBatting || hasPitching;
}

export async function resolveStatForPlayer(options) {
  //console.log("🧪 Calling resolveStatForPlayer with:", options);

  const {
    player_id,
    player_name,
    game_id,
    team,
    prop_type,
    mode,
    batter_id,
    pitcher_id,
  } = options;

  // ✅ Handle BvP logic
  if (mode === "bvp") {
    const stats = await getBatterVsPitcherStats(batter_id, pitcher_id);
    //console.log("🎯 BvP resolved stats:", stats);
    return { rawStats: stats };
  }

  // ✅ Handle PvB logic
  if (mode === "pvb") {
    const stats = await getPitcherVsBatterStats(pitcher_id, batter_id);
    //console.log("🎯 PvB resolved stats:", stats);
    return { rawStats: stats };
  }

  console.log(
    `📡 Resolving stat for ${player_name} (${prop_type}) — Game ID: ${game_id}`
  );

  const boxscoreData = await getPlayerStatsFromBoxscore({
    game_id,
    player_id,
    player_name,
    team,
    prop_type,
  });

  if (!boxscoreData) {
    console.warn(`📭 No boxscore data found for ${player_name} (${prop_type})`);
    return { result: undefined, source: "no_boxscore", rawStats: undefined };
  }

  const rawStats = flattenPlayerBoxscore(boxscoreData);

  if (rawStats === null) {
    console.log(`📊 Raw stats for ${player_name} (${prop_type}): null`);
  } else if (typeof rawStats === "object") {
    const keys = Object.keys(rawStats);
    console.log(`📊 Raw stats for ${player_name} (${prop_type}):`, rawStats);
    console.log(
      `🔬 Keys present in rawStats:`,
      keys.length ? keys : "(empty object)"
    );
  } else {
    console.log(
      `❓ Unexpected rawStats type for ${player_name}:`,
      typeof rawStats
    );
  }

  if (rawStats && hasMeaningfulStats(rawStats)) {
    try {
      const extracted = derivePropValue(prop_type, rawStats);

      if (extracted == null) {
        console.warn(
          `⚠️ Could not extract value for ${player_name} (${prop_type})`
        );
      }

      console.log(`🎯 Extracted value from boxscore: ${extracted}`);

      if (extracted != null) {
        return {
          result: extracted,
          source: "boxscore",
          rawStats,
        };
      }
    } catch (err) {
      console.error(
        `❌ Extraction failed for ${player_name} (${prop_type})`,
        err
      );
    }
  } else {
    console.warn(
      `⚠️ Boxscore stats were invalid for ${player_name} (${prop_type})`
    );
  }

  // fallback to live
  const liveResult = await getStatFromLiveFeed(game_id, player_id, prop_type);

  console.log(`📺 Live fallback result for ${player_name}:`, liveResult);
  console.log(
    `🧪 Final result for ${player_name} (${prop_type}) → ${
      liveResult ?? "null"
    }`
  );

  return {
    result: typeof liveResult === "number" ? liveResult : undefined,
    source: typeof liveResult === "number" ? "live" : "missing",
    rawStats,
  };
}
