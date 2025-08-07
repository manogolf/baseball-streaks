// File: backend/scripts/shared/propUtilsBackend.js

export const VALID_PROP_TYPES = [
  "hits",
  "strikeouts_batting",
  "home_runs",
  "rbis",
  "runs",
  "total_bases",
  "walks",
  "stolen_bases",
  "strikeouts_pitching",
  "outs_recorded",
  "earned_runs",
  "hits_allowed",
  "walks_allowed",
  "pitching_outs",
  "pitch_count",
  "runs_allowed",
  "singles",
  "doubles",
  "triples",
];

// Maps propType to appropriate stat in the stats object
export function extractStatForPropType(stats, propType) {
  if (!stats || typeof stats !== "object") return null;

  switch (propType) {
    case "hits":
      return stats.hits;
    case "strikeouts_batting":
      return stats.strikeOuts;
    case "home_runs":
      return stats.homeRuns;
    case "rbis":
      return stats.rbi;
    case "runs":
      return stats.runs;
    case "total_bases":
      return stats.totalBases;
    case "walks":
      return stats.baseOnBalls;
    case "stolen_bases":
      return stats.stolenBases;
    case "singles":
      return stats.singles;
    case "doubles":
      return stats.doubles;
    case "triples":
      return stats.triples;

    case "strikeouts_pitching":
      return stats.strikeOuts;
    case "outs_recorded":
    case "pitching_outs":
      return stats.outs;
    case "earned_runs":
      return stats.earnedRuns;
    case "hits_allowed":
      return stats.hits;
    case "walks_allowed":
      return stats.baseOnBalls;
    case "pitch_count":
      return stats.pitches;
    case "runs_allowed":
      return stats.runs;

    default:
      return null;
  }
}

// Compute rolling average over recent games
export function getRollingAverage(history, propType, windowSize) {
  if (!Array.isArray(history) || !propType) return null;

  const recent = history.slice(0, windowSize);
  const values = recent
    .map((game) => extractStatForPropType(game?.stats, propType))
    .filter((v) => typeof v === "number");

  if (!values.length) return null;

  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

export function normalizePropType(label) {
  return label.toLowerCase().replace(/[()]/g, "").replace(/\s+/g, "_");
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
