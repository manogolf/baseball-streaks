import fetch from "node-fetch";

// Extracts stat from live feed JSON based on prop type
export async function getStatFromLiveFeed(gameId, playerId, propType) {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const allPlays = json?.liveData?.plays?.allPlays || [];
    const normalizedType = propType.toLowerCase().replace(/[_\s]/g, "");

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

      switch (normalizedType) {
        case "hits":
          if (isBatter && result.eventType === "hit") stat++;
          break;
        case "walks":
          if (isBatter && result.eventType === "walk") stat++;
          break;
        case "singles":
          if (isBatter && result.event === "Single") stat++;
          break;
        case "rbis":
          if (isBatter) stat += result.rbi ?? 0;
          break;
        case "runsscored":
          if (
            runners.some(
              (r) =>
                r.movement?.end === "score" &&
                r.details?.runner?.id === Number(playerId)
            )
          ) {
            stat++;
          }
          break;
        case "stolenbases":
          if (
            play.eventType === "stolen_base" &&
            runners.some((r) => r.details?.runner?.id === Number(playerId))
          ) {
            stat++;
          }
          break;
        case "strikeoutspitching":
          if (isPitcher && result.event === "Strikeout") stat++;
          break;
        case "strikeoutsbatting":
          if (isBatter && result.event === "Strikeout") stat++;
          break;
        case "hitsallowed":
          if (isPitcher && result.eventType === "hit") stat++;
          break;
        default:
          console.warn(`⚠️ Unknown propType: ${propType}`);
          return null;
      }
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
