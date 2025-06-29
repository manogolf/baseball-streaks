// src/utils/buildFeatureVector.js
import { supabase } from "@shared/supabaseUtils.js";
import { checkIfHome, getPlayerID } from "@shared/playerUtils.js";
import { getGamePkForTeamOnDate } from "@shared/fetchGameID.js";
import { todayET, toISODate } from "@shared/timeUtils.js";
import { getOpponentAbbreviation } from "@shared/teamNameMap.js";

console.log("🧪 buildFeatureVector: LIVE VERSION ACTIVE");

export async function buildFeatureVector({
  player_name,
  team,
  prop_type,
  prop_value,
  over_under,
  game_date,
}) {
  const dateISO = toISODate(game_date);
  const player_id = await getPlayerID(player_name, team);

  if (!player_id) {
    console.warn(`⚠️ Could not resolve player_id for ${player_name} (${team})`);
    return null;
  }

  // 1. Rolling avg + streaks
  let recentProps = [];
  try {
    const { data = [] } = await supabase
      .from("model_training_props")
      .select("outcome")
      .eq("player_id", player_id)
      .eq("prop_type", prop_type)
      .lt("game_date", dateISO)
      .order("game_date", { ascending: false })
      .limit(7);
    recentProps = data;
  } catch (e) {
    console.warn(`⚠️ Failed to fetch recent props: ${e.message}`);
  }

  const wins = recentProps.filter((p) => p.outcome === "win").length;
  const avgWinRate = recentProps.length ? wins / recentProps.length : null;

  let hitStreak = 0;
  let winStreak = 0;
  for (const prop of recentProps) {
    if (prop.outcome === "win") {
      hitStreak++;
      winStreak++;
    } else break;
  }

  // 2. Game ID + home/away
  let game_id = null;
  let isHome = false;
  try {
    game_id = await getGamePkForTeamOnDate(team, game_date);
    isHome = await checkIfHome(team, game_id);
  } catch (e) {
    console.warn(`⚠️ Failed home/away check: ${e.message}`);
  }

  // 3. Opponent (now safe after game_id is resolved)
  const opponent = await getOpponentAbbreviation(team, game_id);

  // 4. opponent_win_rate
  let opponent_win_rate = null;
  try {
    const { data: opponentGames = [] } = await supabase
      .from("model_training_props")
      .select("outcome")
      .eq("player_id", player_id)
      .eq("prop_type", prop_type)
      .eq("opponent", opponent)
      .lt("game_date", dateISO)
      .order("game_date", { ascending: false })
      .limit(5);

    const oppWins = opponentGames.filter((p) => p.outcome === "win").length;
    opponent_win_rate = opponentGames.length
      ? oppWins / opponentGames.length
      : 0.5;
  } catch (e) {
    console.warn(`⚠️ Failed opponent_win_rate calc: ${e.message}`);
  }

  // 5. opponent_avg_win_rate
  let opponent_avg_win_rate = null;
  try {
    const { data: oppMatchups = [] } = await supabase
      .from("model_training_props")
      .select("outcome")
      .eq("prop_type", prop_type)
      .eq("opponent", opponent)
      .lt("game_date", dateISO);

    const oppWins = oppMatchups.filter((p) => p.outcome === "win").length;
    opponent_avg_win_rate = oppMatchups.length
      ? oppWins / oppMatchups.length
      : null;
  } catch (e) {
    console.warn(`⚠️ Failed to calculate opponent_avg_win_rate: ${e.message}`);
  }

  // 6. BvP / PvB
  const bvpPvB = {
    bvp_pa: 0,
    bvp_ab: 0,
    bvp_hits: 0,
    bvp_hr: 0,
    bvp_so: 0,
    bvp_bb: 0,
    pvb_pa: 0,
    pvb_ab: 0,
    pvb_hits: 0,
    pvb_hr: 0,
    pvb_so: 0,
    pvb_bb: 0,
  };

  try {
    const { data: matchupStats } = await supabase
      .from("model_training_props")
      .select(
        "bvp_pa, bvp_ab, bvp_hits, bvp_hr, bvp_so, bvp_bb, pvb_pa, pvb_ab, pvb_hits, pvb_hr, pvb_so, pvb_bb"
      )
      .eq("player_id", player_id)
      .eq("prop_type", prop_type)
      .order("game_date", { ascending: false })
      .limit(20); // buffer size

    const validRow = (matchupStats || []).find((row) => row.bvp_pa !== null);

    if (validRow) {
      Object.assign(bvpPvB, validRow);
    }
  } catch (e) {
    console.warn(`⚠️ Failed to fetch BvP/PvB stats: ${e.message}`);
  }

  return {
    prop_type,
    prop_value,
    over_under,
    player_id,
    rolling_result_avg_7: avgWinRate ?? 0.5,
    hit_streak: hitStreak,
    win_streak: winStreak,
    is_home: isHome ? 1 : 0,
    opponent_win_rate,
    opponent_avg_win_rate: opponent_avg_win_rate ?? 0.5,
    ...bvpPvB,
  };
}
