// backend/scripts/shared/mlbApiUtils.js
import fetch from "node-fetch";
import { getTeamInfoByAbbr } from "./teamNameMap.js";
import {
  getGameStartTimeET,
  getDayOfWeekET,
  getTimeOfDayBucketET,
} from "./timeUtils.js";

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

/**
 * Fetches full game context for a given game ID and team.
 * Requires team abbreviation to determine home/away.
 */
export async function getGameContextFields(gameId, teamAbbr) {
  const boxscore = await getBoxscoreFromGameID(gameId);

  const homeTeam = boxscore?.teams?.home?.team?.abbreviation;
  const awayTeam = boxscore?.teams?.away?.team?.abbreviation;

  if (!homeTeam || !awayTeam || !teamAbbr) {
    console.warn(`⚠️ Could not determine teams for game ${gameId}`);
    return null;
  }

  const is_home = teamAbbr === homeTeam;
  const home_away = is_home ? "home" : "away";
  const opponent = is_home ? awayTeam : homeTeam;

  const teamInfo = getTeamInfoByAbbr(opponent);
  const opponent_encoded = teamInfo?.abbr || null;
  const opponent_team_id = teamInfo?.id || null;

  const game_time = await getGameStartTimeET(gameId);
  const game_day_of_week = game_time ? getDayOfWeekET(game_time) : null;
  const time_of_day_bucket = game_time ? getTimeOfDayBucketET(game_time) : null;

  return {
    is_home,
    home_away,
    opponent,
    opponent_encoded,
    opponent_team_id,
    game_time,
    game_day_of_week,
    time_of_day_bucket,
  };
}
