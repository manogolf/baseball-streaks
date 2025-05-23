import { supabase } from "./supabaseUtils.js";
import { nowET, todayET, currentTimeET } from "./timeUtils.js";
import { STAT_FIELD_MAP } from "../../utils/derivePropValue.js";
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
