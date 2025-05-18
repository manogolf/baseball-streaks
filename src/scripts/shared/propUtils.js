import { supabase } from "./supabaseUtils.js";
import { nowET, todayET, currentTimeET } from "./timeUtils.js";

// 🏷️ Stat Extractors by Prop Type
export const propExtractors = {
  Hits: (stats) => stats.hits,
  "Runs Scored": (stats) => stats.runs,
  RBIs: (stats) => stats.rbi,
  "Home Runs": (stats) => stats.homeRuns,
  Walks: (stats) => stats.baseOnBalls,
  "Stolen Bases": (stats) => stats.stolenBases,
  Singles: (stats) => stats.singles,
  Doubles: (stats) => stats.doubles,
  Triples: (stats) => stats.triples,
  "Total Bases": (stats) => stats.totalBases,
  "Hits + Runs + RBIs": (stats) => stats.hits + stats.runs + stats.rbi,
  "Runs + RBIs": (stats) => stats.runs + stats.rbi,
  "Outs Recorded": (stats) => stats.outs,
  "Strikeouts (Batting)": (stats) => stats.strikeOuts,
  "Strikeouts (Pitching)": (stats) => stats.pitStrikeOuts || null,
  "Earned Runs": (stats) => stats.earnedRuns,
  "Hits Allowed": (stats) => stats.hitsAllowed || null,
  "Walks Allowed": (stats) => stats.walksAllowed || null,
};

// 📌 Normalize Prop Type to Match Extractors
export function normalizePropType(propType) {
  if (!propType) return null;

  const formatted = propType
    .toLowerCase()
    .replace(/[()]/g, "") // remove stray parentheses
    .replace(/\s*\+\s*/g, "_") // replace ' + ' with underscore
    .replace(/\s+/g, "_") // replace remaining spaces with underscores
    .replace(/_+$/, "") // remove trailing underscores
    .trim();

  return formatted;
}

// 📅 Expire Old Pending Props (2+ days old)
export async function expireOldPendingProps() {
  const twoDaysAgo = nowET().minus({ days: 2 }).toISODate();

  const { data, error } = await supabase
    .from("player_props")
    .delete()
    .eq("status", "pending")
    .lt("game_date", twoDaysAgo);

  if (error) {
    console.error("⚠️ Failed to delete old pending props:", error.message);
  } else {
    const deletedCount = data?.length || 0;
    console.log(`🧹 Deleted ${deletedCount} stale pending props.`);
  }
}

// 📋 Get Pending Props for Processing
export async function getPendingProps() {
  const { data, error } = await supabase
    .from("player_props")
    .select("*")
    .eq("status", "pending")
    .or(
      `game_date.lt.${todayET()},and(game_date.eq.${todayET()},game_time.lte.${currentTimeET()}),and(game_date.eq.${todayET()},game_time.is.null)`
    )
    .order("game_date", { ascending: false })
    .order("game_time", { ascending: false });

  if (error) {
    console.error("❌ Failed to fetch pending props:", error.message);
    return [];
  }

  return data.filter(
    (prop) =>
      prop.game_date < todayET() ||
      (prop.game_date === todayET() && prop.game_time <= currentTimeET())
  );
}

// 🔠 Display label formatter from normalized key
export function getPropDisplayLabel(normalizedKey) {
  const extractorLabels = Object.keys(propExtractors);
  const match = extractorLabels.find(
    (label) => normalizePropType(label) === normalizedKey
  );
  return match || normalizedKey;
}
