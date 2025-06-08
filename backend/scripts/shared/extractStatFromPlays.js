// 📁 extractStatFromPlays.js

// ✅ Pure function to derive stat value from live feed plays
// No fetch, no Supabase — fully testable

export function extractStatFromPlays(plays, playerId, normalizedPropType) {
  if (!Array.isArray(plays)) return null;
  let value = 0;
  const pid = parseInt(playerId);

  for (const play of plays) {
    const batterId = play.matchup?.batter?.id;
    if (batterId !== pid) continue;

    const result = play.result?.eventType?.toLowerCase();

    switch (normalizedPropType) {
      case "walks":
        if (result === "walk" || result === "hit_by_pitch") value++;
        break;
      case "runs":
      case "runs_scored":
        if (
          play.runners?.some(
            (r) => r.movement?.end === "score" && r.runner?.id === pid
          )
        ) {
          value++;
        }
        break;
      case "rbis":
        if (play.runners?.some((r) => r.rbi && r.responsiblePitcher)) value++;
        break;
      case "strikeouts_batting":
        if (result === "strikeout") value++;
        break;
      case "total_bases":
        if (result === "single") value += 1;
        else if (result === "double") value += 2;
        else if (result === "triple") value += 3;
        else if (result === "home_run") value += 4;
        break;
      case "hits":
        if (["single", "double", "triple", "home_run"].includes(result))
          value++;
        break;
      case "home_runs":
        if (result === "home_run") value++;
        break;
      case "doubles":
        if (result === "double") value++;
        break;
      case "triples":
        if (result === "triple") value++;
        break;
      case "singles":
        if (result === "single") value++;
        break;
      case "stolen_bases":
        if (result === "stolen_base") value++;
        break;
    }
  }

  return value;
}
