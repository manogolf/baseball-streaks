// backend/scripts/shared/mlbApiUtils.js
import fetch from "node-fetch";

/**
 * Returns full boxscore JSON for a given MLB game_id.
 * @param {number|string} gameId
 * @returns {Promise<Object|null>}
 */
export async function getBoxscoreFromGameID(gameId) {
  const url = `https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`❌ Failed to fetch boxscore for game ${gameId}:`, err);
    return null;
  }
}
