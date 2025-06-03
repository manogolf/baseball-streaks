import { supabase } from "./supabaseUtils.js";
import { toISODate, todayET, currentTimeET } from "./timeUtils.js";
import { STAT_FIELD_MAP } from "../../../src/utils/derivePropValue.js";
import { validateStatBlock } from "./playerUtils.js"; // adjust path if needed

// 🧠 Extractor map: Maps prop types to stat extraction logic
export const propExtractors = {
  hits: (stats) => stats.hits,
  runs_scored: (stats) => stats.runs,
  rbis: (stats) => stats.rbi,
  home_runs: (stats) => stats.home_runs,
  singles: (stats) =>
    (stats.hits || 0) -
    (stats.doubles || 0) -
    (stats.triples || 0) -
    (stats.home_runs || 0),
  doubles: (stats) => stats.doubles,
  triples: (stats) => stats.triples,
  walks: (stats) => stats.walks,
  strikeouts_batting: (stats) => stats.strikeouts,
  stolen_bases: (stats) => stats.stolen_bases,
  total_bases: (stats) =>
    (stats.hits || 0) -
    (stats.doubles || 0) -
    (stats.triples || 0) -
    (stats.home_runs || 0) +
    2 * (stats.doubles || 0) +
    3 * (stats.triples || 0) +
    4 * (stats.home_runs || 0),
  hits_runs_rbis: (stats) =>
    (stats.hits || 0) + (stats.runs || 0) + (stats.rbi || 0),
  runs_rbis: (stats) => (stats.runs || 0) + (stats.rbi || 0),

  // Pitching props
  outs_recorded: (stats) => stats.outs,
  strikeouts_pitching: (stats) => stats.strikeOuts,
  walks_allowed: (stats) => stats.baseOnBalls,
  earned_runs: (stats) => stats.earnedRuns,
  hits_allowed: (stats) => stats.hits,
};

// ✅ Returns whether the stat value is a number
export function isStatEligibleForPropType(stats, propType) {
  const value = propExtractors[propType]?.(stats);
  return typeof value === "number" && !isNaN(value);
}

// ✅ Converts prop types like "Strikeouts (Batting)" -> "strikeouts_batting"
export function normalizePropType(label) {
  return label.toLowerCase().replace(/[()]/g, "").replace(/\s+/g, "_");
}

// ✅ Human-readable labels for prop types
const DISPLAY_LABELS = {
  hits: "Hits",
  runs_scored: "Runs Scored",
  rbis: "RBIs",
  home_runs: "Home Runs",
  singles: "Singles",
  doubles: "Doubles",
  triples: "Triples",
  walks: "Walks",
  strikeouts_batting: "Strikeouts (Batting)",
  stolen_bases: "Stolen Bases",
  total_bases: "Total Bases",
  hits_runs_rbis: "Hits + Runs + RBIs",
  runs_rbis: "Runs + RBIs",
  outs_recorded: "Outs Recorded",
  strikeouts_pitching: "Strikeouts (Pitching)",
  walks_allowed: "Walks Allowed",
  earned_runs: "Earned Runs",
  hits_allowed: "Hits Allowed",
};

export function getPropDisplayLabel(propType) {
  return DISPLAY_LABELS[propType] || propType;
}

// ✅ Used by PlayerPropForm.js
export function getPropTypeOptions() {
  return Object.keys(STAT_FIELD_MAP)
    .map((propType) => ({
      value: propType,
      label: getPropDisplayLabel(propType),
    }))
    .sort((a, b) => a.label.localeCompare(b.label)); // ✅ Alphabetical order
}

export function expireOldPendingProps(props = []) {
  const todayISO = toISODate(todayET());

  return props.map((prop) => {
    const propDate = toISODate(prop.game_date); // normalize to ISO
    if (prop.status === "pending" && propDate < todayISO) {
      return { ...prop, status: "expired" };
    }
    return prop;
  });
}

export function determineStatus(actual, line, overUnder) {
  const direction = overUnder?.toLowerCase();
  if (actual === line) return "push";
  return (actual > line && direction === "over") ||
    (actual < line && direction === "under")
    ? "win"
    : "loss";
}

// 🔍 Determine if the team was home or away
export async function determineHomeAway(team, gameId) {
  const { data, error } = await supabase
    .from("player_props")
    .select("team, is_home, game_id")
    .eq("team", team)
    .eq("game_id", gameId)
    .limit(1)
    .maybeSingle();

  return error || !data ? null : data.is_home;
}

// 🔍 Determine the opponent for a given team and game
export async function determineOpponent(team, gameId) {
  const { data, error } = await supabase
    .from("player_props")
    .select("team")
    .eq("game_id", gameId)
    .neq("team", team)
    .limit(1)
    .maybeSingle();

  return error || !data ? null : data.team;
}

// 🔁 Calculate rolling 7-game average for this player and prop type
export async function getRollingAverage(playerId, propType, gameDate) {
  const { data, error } = await supabase
    .from("model_training_props")
    .select("result, game_date")
    .eq("player_id", playerId)
    .eq("prop_type", propType)
    .lt("game_date", gameDate)
    .order("game_date", { ascending: false })
    .limit(7);

  if (error || !data || data.length === 0) return null;

  const values = data
    .map((row) => parseFloat(row.result))
    .filter((v) => !isNaN(v));
  if (values.length === 0) return null;

  const sum = values.reduce((acc, v) => acc + v, 0);
  return parseFloat((sum / values.length).toFixed(2));
}

export async function getSyntheticLine(propType, daysBack = 60) {
  const cutoffDate = toISODate(new Date(Date.now() - daysBack * 86400000)); // 'YYYY-MM-DD'

  const { data, error } = await supabase
    .from("player_props")
    .select("prop_value")
    .eq("prop_type", propType)
    .eq("source", "user_added")
    .gte("game_date", cutoffDate)
    .order("game_date", { ascending: false })
    .limit(1000); // fetch up to 1000 recent props

  if (error || !data || data.length === 0) {
    console.warn(`⚠️ No real lines found for ${propType}, using fallback.`);
    return getStaticFallbackLine(propType);
  }

  const values = data
    .map((d) => parseFloat(d.prop_value))
    .filter((v) => !isNaN(v));

  if (values.length === 0) {
    return getStaticFallbackLine(propType);
  }

  // Compute median
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];

  return median;
}

export function getStaticFallbackLine(propType) {
  const defaultLines = {
    hits: 1.5,
    home_runs: 0.5,
    rbis: 0.5,
    runs_scored: 0.5,
    strikeouts_batting: 1.5,
    walks: 0.5,
    total_bases: 1.5,
    hits_runs_rbis: 2.5,
    runs_rbis: 1.5,
    doubles: 0.5,
    triples: 0.5,
    stolen_bases: 0.5,
    walks_allowed: 1.5,
    hits_allowed: 4.5,
    earned_runs: 2.5,
    outs_recorded: 15.5,
    strikeouts_pitching: 4.5,
    singles: 0.5,
  };
  return defaultLines[propType] ?? 1.0;
}
