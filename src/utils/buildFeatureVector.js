// src/utils/buildFeatureVector.js
import { supabase } from "../lib/supabaseClient.js";
import { DateTime } from "luxon";

export async function buildFeatureVector({
  player_name,
  team,
  prop_type,
  game_date,
}) {
  const dateISO = DateTime.fromISO(game_date).toISODate();

  // 1. Recent player outcomes
  const { data: recentProps, error: propError } = await supabase
    .from("player_props")
    .select("outcome")
    .eq("player_name", player_name)
    .eq("prop_type", prop_type)
    .lt("game_date", dateISO)
    .order("game_date", { ascending: false })
    .limit(7);

  const recentOutcomes = recentProps || [];
  const wins = recentOutcomes.filter((p) => p.outcome === "win").length;
  const avgWinRate =
    recentOutcomes.length > 0 ? wins / recentOutcomes.length : 0.5;

  // 2. Streaks
  let hitStreak = 0;
  let winStreak = 0;
  for (const prop of recentOutcomes) {
    if (prop.outcome === "win") {
      hitStreak++;
      winStreak++;
    } else {
      break;
    }
  }

  // 3. Home game check
  const gameRes = await fetch(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${game_date}`
  );
  const gameJson = await gameRes.json();
  let isHome = null;
  let opponent = null;

  for (const date of gameJson.dates || []) {
    for (const game of date.games || []) {
      if (game.teams.away.team.abbreviation === team) {
        isHome = false;
        opponent = game.teams.home.team.abbreviation;
      } else if (game.teams.home.team.abbreviation === team) {
        isHome = true;
        opponent = game.teams.away.team.abbreviation;
      }
    }
  }

  // 4. Generic placeholder
  const opponentAvgWinRate = 0.5;

  // 5. Opponent-level trends
  let opponentWinRate = null;
  if (opponent) {
    const { data: opponentGames, error: oppError } = await supabase
      .from("player_props")
      .select("outcome")
      .eq("player_name", player_name)
      .eq("prop_type", prop_type)
      .eq("opponent", opponent)
      .lt("game_date", dateISO)
      .order("game_date", { ascending: false })
      .limit(5);

    const oppOutcomes = opponentGames || [];
    const oppWins = oppOutcomes.filter((p) => p.outcome === "win").length;
    opponentWinRate =
      oppOutcomes.length > 0 ? oppWins / oppOutcomes.length : null;
  }

  return {
    rolling_result_avg_7: avgWinRate,
    hit_streak: hitStreak,
    win_streak: winStreak,
    is_home: isHome === true ? 1 : 0,
    opponent_avg_win_rate: opponentAvgWinRate,
    opponent_win_rate: opponentWinRate, // ✅ new
  };
}
