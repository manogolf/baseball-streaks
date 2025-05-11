// src/utils/propUtils.js

import { createClient } from "@supabase/supabase-js";
import { nowET, todayET, currentTimeET } from "./timeUtils.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🏷️ Stat Extractors by Prop Type
export const propExtractors = {
  Hits: (stats) => stats.hits,
  Runs: (stats) => stats.runs,
  "Runs Scored": (stats) => stats.runs,
  RBIs: (stats) => stats.rbi,
  "Home Runs": (stats) => stats.homeRuns,
  Walks: (stats) => stats.baseOnBalls,
  Strikeouts: (stats) => stats.strikeOuts,
  "Stolen Bases": (stats) => stats.stolenBases,
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
