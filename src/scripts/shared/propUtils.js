import { supabase } from "./supabaseUtils.js";
import { nowET, todayET, currentTimeET } from "./timeUtils.js";
import { STAT_FIELD_MAP } from "../../utils/derivePropValue.js";
import { validateStatBlock } from "./playerUtils.js"; // adjust path if needed

// 🏷️ Stat Extractors by Prop Type
export function extractStatForPropType(propType, playerData) {
  const statMap = {
    hits: playerData.hits,
    runs_scored: playerData.runs,
    rbis: playerData.rbi,
    home_runs: playerData.home_runs,
    singles:
      (playerData.hits || 0) -
      (playerData.doubles || 0) -
      (playerData.triples || 0) -
      (playerData.home_runs || 0),
    doubles: playerData.doubles,
    triples: playerData.triples,
    walks: playerData.walks,
    strikeouts_batting: playerData.strikeouts_batting,

    stolen_bases: playerData.stolen_bases,
    total_bases:
      (playerData.hits || 0) -
      (playerData.doubles || 0) -
      (playerData.triples || 0) -
      (playerData.home_runs || 0) +
      2 * (playerData.doubles || 0) +
      3 * (playerData.triples || 0) +
      4 * (playerData.home_runs || 0),
    hits_runs_rbis:
      (playerData.hits || 0) + (playerData.runs || 0) + (playerData.rbis || 0),
    runs_rbis: (playerData.runs || 0) + (playerData.rbis || 0),

    // Pitching props
    outs_recorded: playerData.outs_recorded,
    strikeouts_pitching: playerData.strikeouts_pitching,
    walks_allowed: playerData.walks_allowed,
    earned_runs: playerData.earned_runs,
    hits_allowed: playerData.hits_allowed,
  };

  return statMap[propType] ?? null;
}

export function isStatEligibleForPropType(stats, propType) {
  if (!validateStatBlock(stats)) return false;

  const deriveFn = STAT_FIELD_MAP[propType];
  if (!deriveFn) return false;

  try {
    const value = deriveFn(stats);
    return typeof value === "number" && !isNaN(value);
  } catch (err) {
    console.warn(`⚠️ Error checking eligibility for ${propType}:`, err);
    return false;
  }
}

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
  const extractorLabels = Object.keys(STAT_FIELD_MAP);
  const match = extractorLabels.find(
    (label) => normalizePropType(label) === normalizedKey
  );
  return match || normalizedKey;
}
