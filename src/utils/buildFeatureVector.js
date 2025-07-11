// src/utils/buildFeatureVector.js
import { supabase } from "@shared/supabaseUtils.js";
import { checkIfHome, getPlayerID } from "@shared/playerUtils.js";
import { getGamePkForTeamOnDate } from "@shared/fetchGameID.js";
import { todayET, toISODate } from "@shared/timeUtils.js";
import { getOpponentAbbreviation } from "@shared/teamNameMap.js";

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

  // 6. BvP / PvB (MLB API–supported only)
  const bvpPvB = {
    bvp_avg: 0,
    bvp_at_bats: 0,
    bvp_hits: 0,
    bvp_home_runs: 0,
    bvp_rbi: 0,
    bvp_strikeouts: 0,
    bvp_walks: 0,
    bvp_plate_appearances: 0,
    pvb_avg: 0,
    pvb_at_bats: 0,
    pvb_hits: 0,
    pvb_home_runs: 0,
    pvb_strikeouts: 0,
    pvb_walks: 0,
    pvb_plate_appearances: 0,
  };

  console.log("📡 Fetching PvB/BvP stats for", player_id, prop_type);

  try {
    const { data: matchupStats } = await supabase
      .from("model_training_props")
      .select(
        [
          "bvp_plate_appearances",
          "bvp_at_bats",
          "bvp_hits",
          "bvp_home_runs",
          "bvp_strikeouts",
          "bvp_walks",
          "pvb_plate_appearances",
          "pvb_at_bats",
          "pvb_hits",
          "pvb_home_runs",
          "pvb_strikeouts",
          "pvb_walks",
        ].join(",")
      )
      .eq("player_id", player_id)
      .eq("prop_type", prop_type)
      .order("game_date", { ascending: false })
      .limit(20); // buffer size
    console.log("📦 Raw Supabase query complete", matchupStats?.length);

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
