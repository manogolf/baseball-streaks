// ✅ File: backend/scripts/shared/playerUtilsBackend.js (backend-only functions)

import fetch from "node-fetch";
import { getGamePkForTeamOnDate } from "./fetchGameID.js";
import { getBoxscoreFromGameID, getLiveFeedFromGameID } from "./mlbApiUtils.js";
import { getFullTeamAbbreviationFromID } from "../../../shared/teamNameMap.js";
import { normalizePropType } from "./propUtilsBackend.js";
import { toISODate } from "./shared/timeUtilsBackend.js";
import { supabase } from "./supabaseBackend.js";

const missingStreakCache = new Set();

export async function preparePropSubmission({
  supabase,
  player_name,
  team,
  prop_type,
  prop_value,
  over_under,
  game_date,
  game_time = null,
}) {
  const normalizedPropType = normalizePropType(prop_type);
  const dateISO = toISODate(game_date);
  const game_id = await getGamePkForTeamOnDate(team, dateISO);
  const player_id = await getPlayerID(supabase, player_name, team, game_id);

  return {
    player_name,
    team,
    prop_type: normalizedPropType,
    prop_value: parseFloat(prop_value),
    over_under: over_under.toLowerCase(),
    game_date: dateISO,
    game_time,
    game_id,
    player_id: String(player_id),
    prop_source: "user_added",
  };
}

export async function getPlayerStatsFromBoxscore({ game_id, player_id }) {
  const url = `https://statsapi.mlb.com/api/v1/game/${game_id}/boxscore`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const allPlayers = {
      ...data.teams?.home?.players,
      ...data.teams?.away?.players,
    };
    return Object.values(allPlayers).find(
      (p) => String(p.person?.id) === String(player_id)
    );
  } catch (err) {
    console.error("❌ Error fetching boxscore:", err.message);
    return null;
  }
}
export async function getPlayerID(supabase, playerName, teamAbbr) {
  console.log("🔁 getPlayerID restoring original logic:", {
    playerName,
    teamAbbr,
  });

  const { data, error } = await supabase
    .from("model_training_props")
    .select("player_id")
    .eq("player_name", playerName)
    .eq("team", teamAbbr)
    .limit(1);

  if (error || !data || data.length === 0) {
    console.warn("❌ getPlayerID failed for:", playerName, teamAbbr, error);
    return null;
  }

  return data[0].player_id;
}

export async function getOpponentAbbreviation(teamAbbr, gameId) {
  const feed = await getLiveFeedFromGameID(gameId);
  const homeId = feed?.teams?.home?.team?.id;
  const awayId = feed?.teams?.away?.team?.id;
  const homeAbbr = getFullTeamAbbreviationFromID(homeId);
  const awayAbbr = getFullTeamAbbreviationFromID(awayId);
  if (homeAbbr === teamAbbr) return awayAbbr;
  if (awayAbbr === teamAbbr) return homeAbbr;
  return null;
}

export async function upsertPlayerID({
  supabase,
  player_id,
  player_name,
  team,
}) {
  if (!player_id || !player_name) return null;
  const { data, error } = await supabase
    .from("player_ids")
    .upsert([{ player_id, player_name, team }], {
      onConflict: ["player_id"],
    });
  if (error) {
    console.error("Supabase upsert error:", error.message);
    return null;
  }
  return data;
}

export async function getStreaksForPlayer(
  supabase,
  player_id,
  prop_type,
  prop_source = "mlb_api"
) {
  const key = `${player_id}:${prop_type}:${prop_source}`;
  if (missingStreakCache.has(key)) return null;

  const { data, error } = await supabase
    .from("player_streak_profiles")
    .select("streak_count, streak_type")
    .eq("player_id", player_id)
    .eq("prop_type", prop_type)
    .eq("prop_source", prop_source) // 🔥 CRITICAL!
    .single();

  if (error || !data) {
    missingStreakCache.add(key);
    return null;
  }
}
export function flattenPlayerBoxscore(player) {
  if (!player || typeof player !== "object") return {};

  const stats = {};

  if (player.stats?.batting) {
    stats.batting = { ...player.stats.batting };
  }

  if (player.stats?.pitching) {
    stats.pitching = { ...player.stats.pitching };
  }

  return stats;
}

// 🔁 Utility: Get position map from recent player_stats
// Maps player_id => position string (e.g., "P", "C", "1B", etc.)
export async function getPlayerPositionMap(dateStr = null) {
  const query = supabase.from("player_stats").select("player_id, position");
  if (dateStr) query.eq("game_date", dateStr);

  const { data, error } = await query;

  if (error) {
    console.error("❌ Failed to fetch player positions:", error.message);
    return {};
  }

  const map = new Map();
  for (const row of data || []) {
    if (!map.has(row.player_id) && row.position) {
      map.set(row.player_id, row.position);
    }
  }
  return map;
}

// ✅ Utility: Determine if a position string is a pitcher
export function isPitcher(position) {
  if (!position) return false;
  const pos = position.toUpperCase();
  return pos === "P" || pos === "SP" || pos === "RP";
}
