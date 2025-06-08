// 📁 Canonical fallback stat retriever for live feed
import fetch from "node-fetch";
import { normalizePropType } from "../shared/propUtils.js";
import { extractStatFromPlays } from "../shared/extractStatFromPlays.js";

export async function getStatFromLiveFeed(gameId, playerId, propType) {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
  const normalized = normalizePropType(propType);

  try {
    const response = await fetch(url);
    const data = await response.json();

    const plays = data?.liveData?.plays?.allPlays;
    if (!Array.isArray(plays)) {
      console.warn("⚠️ Live feed format unexpected or incomplete.");
      return null;
    }

    return extractStatFromPlays(plays, playerId, normalized);
  } catch (err) {
    console.error(`❌ Live feed fetch failed for game ${gameId}:`, err.message);
    return null;
  }
}
