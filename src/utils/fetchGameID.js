import { getFullTeamName } from "./teamNameMap.js";

async function getGamePkForTeamOnDate(teamAbbr, gameDate) {
  const fullTeamName = getFullTeamName(teamAbbr);

  if (!fullTeamName) {
    console.warn(`❌ Team abbreviation not recognized: ${teamAbbr}`);
    return null;
  }

  const apiUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}`;
  console.log(`📡 Fetching schedule from: ${apiUrl}`);

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) {
      console.error(`❌ Failed to fetch schedule: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const games = data.dates?.[0]?.games ?? [];

    if (games.length === 0) {
      console.warn(`📅 No games found on ${gameDate}.`);
      return null;
    }

    const match = games.find(
      (game) =>
        game.teams.away.team.name === fullTeamName ||
        game.teams.home.team.name === fullTeamName
    );

    if (!match) {
      console.warn(
        `❌ No game found for team: ${fullTeamName} on ${gameDate}.`
      );
      console.log(
        "📦 Games on date:",
        games.map((g) => ({
          home: g.teams.home.team.name,
          away: g.teams.away.team.name,
          gamePk: g.gamePk,
        }))
      );
      return null;
    }

    const game_id = match.gamePk;
    console.log(
      `🎮 Found game ID for ${fullTeamName} on ${gameDate}: ${game_id}`
    );
    return game_id;
  } catch (err) {
    console.error(
      `🔥 Error fetching game ID for ${fullTeamName} on ${gameDate}:`,
      err
    );
    return null;
  }
}

export { getGamePkForTeamOnDate };
