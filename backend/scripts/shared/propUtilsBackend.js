// File: backend/scripts/shared/propUtilsBackend.js

import { derivePropValue } from "../resolution/derivePropValue.js";
import { isPitcher } from "./playerUtilsBackend.js";

// Determine which prop types apply to which player roles
export const pitcherPropTypes = [
  "strikeouts_pitching",
  "earned_runs",
  "hits_allowed",
  "walks_allowed",
  "outs_recorded",
];

export const batterPropTypes = [
  "hits",
  "runs_scored",
  "rbis",
  "home_runs",
  "total_bases",
  "strikeouts_batting",
  "walks",
  "singles",
  "doubles",
  "triples",
  "hits_runs_rbis",
];

// 🔎 Normalize prop type strings from various forms
export function normalizePropType(rawPropType) {
  if (!rawPropType) return null;

  const lower = rawPropType.toLowerCase().replace(/[^a-z]/g, "");
  const map = {
    hits: "hits",
    runsscored: "runs_scored",
    rbis: "rbis",
    homeruns: "home_runs",
    totalbases: "total_bases",
    strikeoutsbatting: "strikeouts_batting",
    walks: "walks",
    singles: "singles",
    doubles: "doubles",
    triples: "triples",
    hitsrunsrbis: "hits_runs_rbis",

    strikeoutspitching: "strikeouts_pitching",
    earnedruns: "earned_runs",
    hitsallowed: "hits_allowed",
    walksallowed: "walks_allowed",
    outsrecorded: "outs_recorded",
  };

  return map[lower] || rawPropType;
}

// 🧠 Return prop type options grouped by player role
export function getPropTypeOptions(isPitcherFlag) {
  if (isPitcherFlag) {
    return pitcherPropTypes.map((p) => ({
      value: p,
      label: formatPropType(p),
    }));
  }

  return batterPropTypes.map((p) => ({
    value: p,
    label: formatPropType(p),
  }));
}

// 📐 Converts 'hits_runs_rbis' → 'Hits + Runs + RBIs'
export function formatPropType(propType) {
  const parts = propType.split("_");
  return parts
    .map((p) => {
      if (p === "rbis") return "RBIs";
      if (p === "runs") return "Runs";
      if (p === "scored") return ""; // skip
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .filter(Boolean)
    .join(" + ");
}

// 🧪 Determine whether the prop is pitcher-related
export function isPitcherProp(propType) {
  return pitcherPropTypes.includes(normalizePropType(propType));
}

// 🧪 Determine whether the prop is batter-related
export function isBatterProp(propType) {
  return batterPropTypes.includes(normalizePropType(propType));
}

// 🪄 Determine whether a player should receive this prop type
export function playerMatchesPropType(player, propType) {
  if (!player || !propType) return false;

  if (isPitcher(player)) {
    return isPitcherProp(propType);
  }

  return isBatterProp(propType);
}

/**
 * Wrapper to extract a prop value from player stats.
 * Used only in backend.
 */
export function extractStatForPropType(propType, stats) {
  return derivePropValue(propType, stats);
}
