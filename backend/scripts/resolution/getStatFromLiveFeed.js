// backend/scripts/resolution/getStatFromLiveFeed.js
import fetch from "node-fetch";
import { normalizePropType } from "../shared/propUtils.js";

// Extracts stat from allPlays in the live feed JSON
function extractLiveStat(normalizedType, { allPlays, playerId }) {
  let value = 0;

  for (const play of allPlays) {
    const { result, matchup } = play;

    // Check if the batter/pitcher matches the target player
    const batterId = matchup?.batter?.id;
    const pitcherId = matchup?.pitcher?.id;

    const isBatter = batterId === parseInt(playerId);
    const isPitcher = pitcherId === parseInt(playerId);

    switch (normalizedType) {
      case "hits":
        if (isBatter && result?.eventType === "hit") value++;
        break;
      case "singles":
        if (isBatter && result?.eventType === "single") value++;
        break;
      case "doubles":
        if (isBatter && result?.eventType === "double") value++;
        break;
      case "triples":
        if (isBatter && result?.eventType === "triple") value++;
        break;
      case "home_runs":
        if (isBatter && result?.eventType === "home_run") value++;
        break;
      case "strikeouts_batting":
        if (isBatter && result?.eventType === "strikeout") value++;
        break;
      case "strikeouts_pitching":
        if (isPitcher && result?.eventType === "strikeout") value++;
        break;
      case "walks":
        if (isBatter && result?.eventType === "walk") value++;
        break;
      case "walks_allowed":
        if (isPitcher && result?.eventType === "walk") value++;
        break;
      case "hit_by_pitch":
        if (isBatter && result?.eventType === "hit_by_pitch") value++;
        break;
      default:
        // Stat not handled in live feed
        break;
    }
  }

  return value;
}

// Fetches live feed and extracts stat
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
