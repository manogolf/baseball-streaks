// src/utils/buildFeatureVector.js
import { supabase } from "../scripts/shared/supabaseUtils.js";
import { checkIfHome, getPlayerID } from "../scripts/shared/playerUtils.js";
import { getGamePkForTeamOnDate } from "../scripts/shared/fetchGameID.js";
import { todayET, toISODate } from "../scripts/shared/timeUtils.js"; // ✅ Using utilities only

export async function buildFeatureVector({
  player_name,
  team,
  prop_type,
  prop_value,
  over_under,
  game_date,
}) {
  const today = todayET();
  const dateISO = toISODate(game_date); // ✅ Using timeUtils

  // 1. Recent player outcomes
  const { data: recentProps = [] } = await supabase
    .from("player_props")
    .select("outcome")
    .eq("player_name", player_name)
    .eq("prop_type", prop_type)
    .lt("game_date", dateISO)
    .order("game_date", { ascending: false })
    .limit(7);

  const wins = recentProps.filter((p) => p.outcome === "win").length;
  const avgWinRate = recentProps.length > 0 ? wins / recentProps.length : 0.5;

  // 2. Streaks
  let hitStreak = 0;
  let winStreak = 0;
  for (const prop of recentProps) {
    if (prop.outcome === "win") {
      hitStreak++;
      winStreak++;
    } else {
      break;
    }
  }

  // 3. Home game check
  const game_id = await getGamePkForTeamOnDate(team, game_date);
  const isHome = await checkIfHome(team, game_id);

  // 4. Opponent-level trends
  let opponentWinRate = null;
  const { data: opponentGames = [] } = await supabase
    .from("player_props")
    .select("outcome")
    .eq("player_name", player_name)
    .eq("prop_type", prop_type)
    // .eq("opponent", team) // ⚠️ Confirm 'opponent' field holds team abbreviation here
    .lt("game_date", dateISO)
    .order("game_date", { ascending: false })
    .limit(5);

  const oppWins = opponentGames.filter((p) => p.outcome === "win").length;
  opponentWinRate =
    opponentGames.length > 0 ? oppWins / opponentGames.length : 0.5;

  // 5. Get player ID
  const player_id = await getPlayerID(player_name, team);

  return {
    prop_type,
    prop_value,
    over_under,
    player_id,
    rolling_result_avg_7: avgWinRate,
    hit_streak: hitStreak,
    win_streak: winStreak,
    is_home: isHome,
    opponent_avg_win_rate: 0.5, // 📌 Placeholder: Replace if you calculate this elsewhere
    opponent_win_rate: opponentWinRate,
  };
}
