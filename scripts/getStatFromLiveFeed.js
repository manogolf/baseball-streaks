import fetch from 'node-fetch';

// Extracts stat from live feed JSON based on prop type
export async function getStatFromLiveFeed(gameId, playerId, propType) {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const allPlays = json?.liveData?.plays?.allPlays || [];

    let stat = 0;

    for (const play of allPlays) {
      const result = play.result;
      const players = play.matchup;
      const batter = players?.batter?.id;
      const pitcher = players?.pitcher?.id;
      const runners = play.runners || [];

      const isBatter = batter === Number(playerId);
      const isPitcher = pitcher === Number(playerId);

      if (!isBatter && !isPitcher) continue;

      switch (propType) {
        case 'Hits':
          if (isBatter && result.eventType === 'hit') stat++;
          break;
        case 'Walks':
          if (isBatter && result.eventType === 'walk') stat++;
          break;
        case 'Singles':
          if (isBatter && result.event === 'Single') stat++;
          break;
        case 'RBIs':
          if (isBatter) stat += result.rbi ?? 0;
          break;
        case 'Runs Scored':
          if (
            runners.some(
              (r) => r.movement?.end === 'score' && r.details?.runner?.id === Number(playerId)
            )
          ) {
            stat++;
          }
          break;
        case 'Stolen Bases':
          if (
            play.eventType === 'stolen_base' &&
            runners.some((r) => r.details?.runner?.id === Number(playerId))
          ) {
            stat++;
          }
          break;
        case 'Strikeouts (Pitching)':
          if (isPitcher && result.event === 'Strikeout') stat++;
          break;
        case 'Strikeouts (Batting)':
          if (isBatter && result.event === 'Strikeout') stat++;
          break;
        case 'Hits Allowed':
          if (isPitcher && result.eventType === 'hit') stat++;
          break;
        default:
          console.warn(`⚠️ Unknown propType: ${propType}`);
          return null;
      }
    }

    return stat;
  } catch (err) {
    console.error(`❌ Failed to fetch live feed for game ${gameId}:`, err.message);
    return null;
  }
}
