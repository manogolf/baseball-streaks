//  shared/enrichGameContext.js

import {
  normalizeTeamAbbreviation,
  getTeamInfoByAbbr,
  teamIdMap,
} from "./teamNameMap.js";
import { getGamePkForTeamOnDate } from "../backend/scripts/shared/fetchGameID.js";
import { getGameSchedule } from "./mlbApiUtilsFrontend.js";
import { getTimeOfDayBucketET } from "./timeUtils.js"; // shared-safe

// 🔍 Helper to fetch live feed for pitcher info
async function getFeedLive(gameId) {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch live feed for game ${gameId}`);
  }
  return await res.json();
}

/**
 * Enriches a user-added prop with game context fields:
 * - game_id
 * - is_home
 * - opponent
 * - opponent_encoded
 * - game_time
 * - game_day_of_week
 * - time_of_day_bucket
 * - starting_pitcher_id
 */
export async function enrichGameContext({ team, gameDate }) {
  const normalizedTeam = normalizeTeamAbbreviation(team);

  // 🎮 Resolve game ID
  const gameId = await getGamePkForTeamOnDate(normalizedTeam, gameDate);
  if (!gameId) {
    console.warn(`❌ No game ID found for ${team} on ${gameDate}`);
    return null;
  }

  // 📅 Get full schedule
  const schedule = await getGameSchedule(gameDate);
  const game = schedule.find((g) => g.gamePk === gameId);
  if (!game) {
    console.warn(`❌ Game ID ${gameId} not found in schedule for ${gameDate}`);
    return null;
  }

  // 🏟️ Determine home/away and opponent
  const homeId = game.teams.home.team.id;
  const awayId = game.teams.away.team.id;

  const teamInfo = getTeamInfoByAbbr(normalizedTeam);
  if (!teamInfo) {
    console.warn(`❌ Could not resolve team info for ${normalizedTeam}`);
    return null;
  }

  const isHome = teamInfo.id === homeId;
  const opponentId = isHome ? awayId : homeId;

  // 🧪 Debug logs to trace opponent resolution
  console.log(`🧪 Resolved opponentId: ${opponentId}`);
  console.log(`🧪 teamIdMap[${opponentId}]:`, teamIdMap[opponentId]);

  const opponentInfo = teamIdMap[opponentId];

  console.log(`🧪 Resolved opponentId: ${opponentId}`);
  console.log(`🧪 teamIdMap[${opponentId}]:`, teamIdMap[opponentId]);

  const opponent = opponentInfo?.abbr ?? null;
  const opponent_encoded = opponentId ?? null;

  if (!opponent) {
    console.warn(
      `❌ Could not resolve opponent for ${normalizedTeam} on ${gameDate}`
    );
  }

  // 🕒 Game time context
  const gameTime = game.gameDate;
  const time_of_day_bucket = getTimeOfDayBucketET(gameTime);
  const game_day_of_week = new Date(gameTime).getDay(); // 0 = Sunday

  // 👤 Fetch probable pitcher from live feed
  let starting_pitcher_id = null;
  try {
    const liveFeed = await getFeedLive(gameId);
    const probable = liveFeed?.gameData?.probablePitchers;
    if (isHome) {
      starting_pitcher_id = probable?.away?.id ?? null;
    } else {
      starting_pitcher_id = probable?.home?.id ?? null;
    }
  } catch (err) {
    console.warn(
      `⚠️ Could not fetch starting pitcher for game ${gameId}:`,
      err.message
    );
  }

  const enriched = {
    game_id: gameId,
    is_home: isHome,
    opponent,
    opponent_encoded,
    game_time: gameTime,
    game_day_of_week,
    time_of_day_bucket,
    starting_pitcher_id,
  };

  console.log(`🎯 Enriched game context for ${team} on ${gameDate}:`, enriched);
  return enriched;
}
