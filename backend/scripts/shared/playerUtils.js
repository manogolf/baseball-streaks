import { supabase } from "./supabaseUtils.js";
import { normalizePropType } from "./propUtils.js";
import { getGamePkForTeamOnDate } from "./fetchGameID.js";
import { toISODate } from "./timeUtils.js";
import { STAT_FIELD_MAP } from "../../../src/utils/derivePropValue.js";
import { getPropDisplayLabel } from "./propUtils.js";

/**
 * Prepares a full prop payload with resolved IDs and normalized fields.
 */

export function didPlayerParticipate(stats) {
  if (!stats || typeof stats !== "object") return false;

  const hasBattingStats =
    stats.batting &&
    Object.values(stats.batting).some((v) => typeof v === "number" && v > 0);

  const hasPitchingStats =
    stats.pitching &&
    Object.values(stats.pitching).some((v) => typeof v === "number" && v > 0);

  return hasBattingStats || hasPitchingStats;
}

export function validateStatBlock(stats) {
  if (!stats || typeof stats !== "object") return false;

  const validBatting = stats.batting && typeof stats.batting === "object";
  const validPitching = stats.pitching && typeof stats.pitching === "object";

  // You can expand this with more rules if needed later
  return validBatting || validPitching;
}

export async function preparePropSubmission({
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
  const player_id = await getPlayerID(player_name, team, game_id);

  return {
    player_name,
    team,
    prop_type: normalizedPropType, // ✅ Normalized at the data layer
    prop_value: parseFloat(prop_value),
    over_under: over_under.toLowerCase(), // ✅ Also normalized to lowercase
    game_date: dateISO,
    game_time,
    game_id,
    player_id: String(player_id), // ✅ Ensure this is explicitly converted to a string
  };
}

// ✅ This is correct
export async function checkIfHome(team, game_id) {
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/game/${game_id}/boxscore`
    );
    const json = await res.json();

    if (!json.teams) return 0;

    const homeTeam = json.teams.home.team.abbreviation;
    return homeTeam === team ? 1 : 0;
  } catch (err) {
    console.error("❌ Error checking if home team:", err);
    return 0;
  }
}

/**
 * Attempts to resolve a player ID using:
 * 1. Local DB match (normalized)
 * 2. Boxscore fallback (if game_id present)
 * 3. Active roster search (as last resort)
 * Auto-inserts resolved ID into Supabase if not already present.
 */
export async function getPlayerID(player_name, team_abbr, game_id) {
  if (!player_name || !team_abbr) return null;

  // ✅ Normalize names: remove accents, punctuation, trim/space
  const normalize = (name) =>
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Remove accents (í → i)
      .replace(/[.,]/g, "") // Remove periods, commas
      .toLowerCase()
      .trim();

  const normalizedTarget = normalize(player_name);

  // ✅ Step 1: Search Supabase for any matching player on the team
  const { data: dbResults, error: dbError } = await supabase
    .from("player_ids")
    .select("player_id, player_name")
    .eq("team", team_abbr);

  if (dbError) {
    console.error(`❌ Supabase query error:`, dbError.message);
  } else if (dbResults?.length) {
    const match = dbResults.find(
      (row) => normalize(row.player_name) === normalizedTarget
    );
    if (match) return match.player_id;
  }

  // ✅ Step 2: Try resolving via boxscore
  if (game_id) {
    const boxscoreUrl = `https://statsapi.mlb.com/api/v1/game/${game_id}/boxscore`;
    try {
      const res = await fetch(boxscoreUrl);
      if (res.ok) {
        const data = await res.json();
        const homePlayers = data.teams?.home?.players || {};
        const awayPlayers = data.teams?.away?.players || {};
        const allPlayers = { ...homePlayers, ...awayPlayers };

        for (const player of Object.values(allPlayers)) {
          const fullName = player?.person?.fullName || "";
          if (normalize(fullName) === normalizedTarget) {
            const resolvedId = player.person.id;

            // ✅ Cache in Supabase
            await supabase.from("player_ids").upsert({
              player_name: fullName,
              team: team_abbr,
              player_id: resolvedId,
            });

            console.log(
              `🆔 Boxscore resolved ID for ${fullName}: ${resolvedId}`
            );
            return resolvedId;
          }
        }
        console.warn(`⚠️ Player not found in boxscore: ${player_name}`);
      } else {
        console.error(`❌ Boxscore fetch failed:`, res.status);
      }
    } catch (err) {
      console.error(`🔥 Error fetching boxscore:`, err.message);
    }
  }

  // ✅ Step 3: Try resolving via team’s active roster
  try {
    const teamListRes = await fetch(
      "https://statsapi.mlb.com/api/v1/teams?sportId=1"
    );
    const teamsData = await teamListRes.json();
    const teams = teamsData.teams || [];
    const team = teams.find((t) => t.abbreviation === team_abbr);

    if (team) {
      const rosterRes = await fetch(
        `https://statsapi.mlb.com/api/v1/teams/${team.id}/roster/Active`
      );
      const rosterData = await rosterRes.json();

      for (const player of rosterData.roster || []) {
        const fullName = player.person.fullName;
        if (normalize(fullName) === normalizedTarget) {
          const resolvedId = player.person.id;

          await supabase.from("player_ids").upsert({
            player_name: fullName,
            team: team_abbr,
            player_id: resolvedId,
          });

          console.log(`🆔 Roster resolved ID for ${fullName}: ${resolvedId}`);
          return resolvedId;
        }
      }
    }
  } catch (err) {
    console.error(`🔥 Error fetching active roster:`, err.message);
  }

  console.warn(
    `❌ Could not resolve Player ID for ${player_name} (${team_abbr})`
  );
  return null;
}

// 📊 Retrieve streaks for a given player_id and prop_type from Supabase
export async function getStreaksForPlayer(player_id, prop_type) {
  if (!player_id || !prop_type) return { streak_count: 0, streak_type: null };

  try {
    const { data, error } = await supabase
      .from("player_streak_profiles")
      .select("streak_count, streak_type")
      .eq("player_id", player_id)
      .eq("prop_type", prop_type)
      .maybeSingle();

    if (error) {
      console.error(
        `❌ Failed to fetch streak profile for ${player_id} (${prop_type}):`,
        error.message
      );
      return { streak_count: 0, streak_type: null };
    }

    return data || { streak_count: 0, streak_type: null };
  } catch (err) {
    console.error(
      `🔥 Unexpected error fetching streaks for ${player_id} (${prop_type}):`,
      err.message
    );
    return { streak_count: 0, streak_type: null };
  }
}

export async function upsertPlayerID({ player_id, player_name, team = null }) {
  if (!player_id || !player_name) {
    console.warn("⚠️ Missing player_id or player_name for upsert");
    return null;
  }

  const { data, error } = await supabase
    .from("player_ids")
    .upsert([{ player_id, player_name, team }], {
      onConflict: ["player_id"],
    });

  if (error) {
    console.error(`❌ Supabase upsert error for ${player_id}:`, error.message);
    return null;
  }

  return data;
}
