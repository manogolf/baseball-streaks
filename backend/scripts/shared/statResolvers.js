// backend/scripts/shared/statResolvers.js

import { fetchGameStatusById } from "./gameStatusUtils.js";
import { getPlayerStatsFromBoxscore } from "../../../src/utils/fetchBoxscoreStats.js";
import { getStatFromLiveFeed } from "../resolution/getStatFromLiveFeed.js";
import { nowET } from "./timeUtils.js";

const LAG_MINUTES_AFTER_FINAL = 15;

/**
 * Returns true if game is final and lag window has passed.
 */
export async function shouldAttemptResolution(gameId) {
  const status = await fetchGameStatusById(gameId);

  if (status?.detailedState !== "Final") return false;

  const endTime = DateTime.fromISO(status.endTime);
  const now = nowET(); // ✅ from timeUtils, not Luxon

  // 📍 Log game state and timing info
  console.log(
    "🕒 Game status:",
    status?.detailedState,
    "End time:",
    status?.endTime
  );
  console.log("🧮 Minutes since end:", now.diff(endTime, "minutes").minutes);

  return now.diff(endTime, "minutes").minutes >= LAG_MINUTES_AFTER_FINAL;
}

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
  const canResolve = await shouldAttemptResolution(game_id);
  if (!canResolve) return { result: null, source: "not_final", rawStats: null };

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

  // 🔁 Flatten the raw stats using the shared util
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

  if (rawStats) {
    try {
      const extractor = statExtractors[prop_type];
      if (!extractor) {
        console.warn(`⚠️ No extractor found for prop type: ${prop_type}`);
      }

      const extracted = extractor?.(rawStats);

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
      `⚠️ Boxscore stats were null for ${player_name} (${prop_type})`
    );
  }

  // fallback
  const liveResult = await getStatFromLiveFeed({
    player_id,
    player_name,
    game_id,
    team,
    prop_type,
  });

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
