//  shared/enrichGameContext.js

import { normalizeTeamAbbreviation, getTeamInfoByAbbr } from "./teamNameMap.js";
import { getGamePkForTeamOnDate } from "..//backend/scripts/shared/fetchGameID.js";
import { getGameSchedule } from "./mlbApiUtilsFrontend.js"; // make sure this lives in /shared

/**
 * Enriches a user-added prop with game context fields:
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

  // Resolve game ID
  const gameId = await getGamePkForTeamOnDate(normalizedTeam, gameDate);
  if (!gameId) {
    console.warn(`❌ No game ID found for ${team} on ${gameDate}`);
    return null;
  }

  // Fetch schedule for context
  const schedule = await getGameSchedule(gameDate);
  const game = schedule.find((g) => g.gamePk === gameId);

  if (!game) {
    console.warn(`❌ Game ID ${gameId} not found in schedule for ${gameDate}`);
    return null;
  }

  const isHome =
    normalizeTeamAbbreviation(game.teams.home.team.abbreviation) ===
    normalizedTeam;
  const opponentAbbr = isHome
    ? game.teams.away.team.abbreviation
    : game.teams.home.team.abbreviation;

  const opponent = normalizeTeamAbbreviation(opponentAbbr);
  const opponentInfo = getTeamInfoByAbbr(opponent);
  const opponent_encoded = opponentInfo?.id ?? null;

  const gameTime = game.gameDate; // ISO string
  const timeET = new Date(gameTime);
  const hour = timeET.getHours();

  const time_of_day_bucket =
    hour < 15 ? "day" : hour < 18 ? "late_day" : "night";

  const game_day_of_week = timeET.getDay(); // 0 = Sunday

  const starting_pitcher_id = isHome
    ? game.teams.away.probablePitcher?.id ?? null
    : game.teams.home.probablePitcher?.id ?? null;

  return {
    game_id: gameId,
    is_home: isHome,
    opponent,
    opponent_encoded,
    game_time: gameTime,
    game_day_of_week,
    time_of_day_bucket,
    starting_pitcher_id,
  };
}
