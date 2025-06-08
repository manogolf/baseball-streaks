// statResolvers.js

import { getStatFromLiveFeed } from "./getStatFromLiveFeed.js";
import {
  flattenPlayerBoxscore,
  getPlayerStatsFromBoxscore,
  validateStatBlock,
} from "../shared/playerUtils.js";
import { derivePropValue } from "../shared/derivePropValue.js";

/**
 * Resolves a stat value using boxscore first, then allPlays as fallback.
 */
export async function resolveStatForPlayer({
  player_id,
  player_name,
  game_id,
  team,
  prop_type,
}) {
  console.log("🧪 Calling resolveStatForPlayer with:", {
    player_id,
    player_name,
    game_id,
    team,
    prop_type,
  });

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
    return { result: null, source: "no_boxscore", rawStats: null };
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

  if (rawStats && validateStatBlock(rawStats)) {
    try {
      const extracted = derivePropValue(rawStats, prop_type);

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
    result: liveResult,
    source: liveResult != null ? "live" : "missing",
    rawStats,
  };
}
