import fetch from "node-fetch";
import { normalizePropType, extractLiveStat } from "../shared/propUtils.js";

// Extracts stat from live feed JSON based on prop type using shared utility
export async function getStatFromLiveFeed(gameId, playerId, propType) {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    // ✅ Ensure game is final
    const gameState = json?.gameData?.status?.abstractGameState;
    if (gameState !== "Final") {
      console.warn(`⏳ Game ${gameId} is not final (status = ${gameState})`);
      return null;
    }

    const allPlays = json?.liveData?.plays?.allPlays || [];
    const normalizedType = normalizePropType(propType);
    console.log("🔍 Normalized propType:", `"${normalizedType}"`);

    const stat = extractLiveStat(normalizedType, { allPlays, playerId });

    if (stat == null) {
      console.warn(
        `⚠️ No stat found for ${normalizedType} (game: ${gameId}, player: ${playerId})`
      );
    }

    return stat;
  } catch (err) {
    console.error(
      `❌ Failed to fetch live feed for game ${gameId}:`,
      err.message
    );
    return null;
  }
}
