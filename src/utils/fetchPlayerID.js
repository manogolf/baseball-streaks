export async function getPlayerID(playerName, gameId) {
  const boxscoreUrl = `https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`;
  const res = await fetch(boxscoreUrl);
  const data = await res.json();

  const normalize = (name) =>
    name
      .toLowerCase()
      .replace(/[\.\,]/g, "")
      .trim();

  const normalizedTarget = normalize(playerName);
  const homePlayers = data.teams.home.players || {};
  const awayPlayers = data.teams.away.players || {};
  const allPlayers = { ...homePlayers, ...awayPlayers };

  for (const [key, player] of Object.entries(allPlayers)) {
    const fullName = player?.person?.fullName || "";
    if (normalize(fullName) === normalizedTarget) {
      return player.person.id; // This is the stable MLB player ID
    }
  }

  console.warn(`❌ Player ID not found for ${playerName}`);
  return null;
}
