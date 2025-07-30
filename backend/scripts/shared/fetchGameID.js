// backend/scripts/shared/fetchGameID.js

import { DateTime } from "luxon";
import { teamNameMap as TEAM_NAME_MAP } from "../../../shared/teamNameMap.js";

export async function getGamePkForTeamOnDate(teamAbbr, dateISO) {
  const fullTeamName = TEAM_NAME_MAP[teamAbbr];
  if (!fullTeamName) {
    console.warn(`⚠️ Unknown team abbreviation: ${teamAbbr}`);
    return null;
  }

  const apiDate = DateTime.fromISO(dateISO).toFormat("yyyy-MM-dd");
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${apiDate}`;

  console.log("📡 Fetching schedule from:", url);
  const res = await fetch(url);
  const json = await res.json();

  const games = json.dates?.[0]?.games || [];
  console.log("📦 Games on date:", games);

  for (const game of games) {
    const { gamePk, teams } = game;
    const homeTeam = teams.home.team.name;
    const awayTeam = teams.away.team.name;

    if (homeTeam === fullTeamName || awayTeam === fullTeamName) {
      console.log(
        `🎮 Found game ID for ${fullTeamName} on ${apiDate}: ${gamePk}`
      );
      return gamePk;
    }
  }

  console.warn(`❌ No game found for team: ${fullTeamName} on ${apiDate}`);
  return null;
}
