// backend/scripts/shared/propUtils.js

import { supabase } from "./supabaseUtils.js";
import { toISODate, todayET } from "./timeUtils.js";
import { derivePropValue } from "../resolution/derivePropValue.js";

// ✅ Canonical list of supported prop types
export const VALID_PROP_TYPES = [
  "hits",
  "runs_scored",
  "rbis",
  "home_runs",
  "singles",
  "doubles",
  "triples",
  "walks",
  "strikeouts_batting",
  "stolen_bases",
  "total_bases",
  "hits_runs_rbis",
  "runs_rbis",
  "outs_recorded",
  "strikeouts_pitching",
  "walks_allowed",
  "earned_runs",
  "hits_allowed",
];

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

export function normalizePropType(label) {
  return label.toLowerCase().replace(/[()]/g, "").replace(/\s+/g, "_");
}

export function getPropDisplayLabel(propType) {
  return DISPLAY_LABELS[propType] || propType;
}

export function getPropTypeOptions() {
  return VALID_PROP_TYPES.map((propType) => ({
    value: propType,
    label: getPropDisplayLabel(propType),
  })).sort((a, b) => a.label.localeCompare(b.label));
}

export function expireOldPendingProps(props = []) {
  const todayISO = toISODate(todayET());
  return props.map((prop) => {
    const propDate = toISODate(prop.game_date);
    if (prop.status === "pending" && propDate < todayISO) {
      return { ...prop, status: "expired" };
    }
    return prop;
  });
}

export function determineStatus(actual, line, overUnder) {
  const direction = overUnder?.toLowerCase?.();

  if (typeof actual !== "number" || typeof line !== "number" || !direction) {
    return "invalid";
  }

  if (actual === line) return "push";

  const isWin =
    (direction === "over" && actual > line) ||
    (direction === "under" && actual < line);

  return isWin ? "win" : "loss";
}

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
  const cutoffDate = toISODate(new Date(Date.now() - daysBack * 86400000));

  const { data, error } = await supabase
    .from("player_props")
    .select("prop_value")
    .eq("prop_type", propType)
    .eq("source", "user_added")
    .gte("game_date", cutoffDate)
    .order("game_date", { ascending: false })
    .limit(1000);

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

export function extractStatForPropType(propType, stats) {
  return derivePropValue(propType, stats);
}
export { derivePropValue };
