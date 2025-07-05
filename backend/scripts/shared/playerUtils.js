import fetch from "node-fetch";
import { supabase } from "./supabaseUtils.js";
import { normalizePropType } from "./propUtils.js";
import { getGamePkForTeamOnDate } from "./fetchGameID.js";
import { toISODate } from "./timeUtils.js";
import { getBoxscoreFromGameID } from "./mlbApiUtils.js";
import { getFullTeamAbbreviationFromID } from "./teamNameMap.js";

// 🧠 Flatten boxscore player stats (converts nested MLB format to simpler object)
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

export async function getPlayerStatsFromBoxscore({ game_id, player_id }) {
  const url = `https://statsapi.mlb.com/api/v1/game/${game_id}/boxscore`;
  console.log(`📡 Fetching boxscore for game ${game_id}`);
  console.log(`🆔 Looking for player ID: ${player_id}`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`❌ Failed to fetch boxscore: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const allPlayers = {
      ...data.teams?.home?.players,
      ...data.teams?.away?.players,
    };

    const match = Object.values(allPlayers).find(
      (p) => String(p.person?.id) === String(player_id)
    );

    if (!match) {
      console.warn(`📭 No boxscore data found for player ID ${player_id}`);
      return null;
    }

    return match;
  } catch (err) {
    console.error("❌ Error during boxscore fetch:", err.message);
    return null;
  }
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

export async function getPlayerID(player_name, team_abbr, game_id) {
  if (!player_name || !team_abbr) return null;

  const normalize = (name) =>
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[.,]/g, "")
      .toLowerCase()
      .trim();

  const normalizedTarget = normalize(player_name);

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

const missingStreakCache = new Set();

export async function getStreaksForPlayer(
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

  return {
    streak_count: data.streak_count,
    streak_type: data.streak_type,
  };
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

// 🔁 Batter-vs-Pitcher (BvP) utilities
// ------------------------------------------------------------
// Strategy:
// 1) Look for a cached row in the `batter_vs_pitcher_stats` table
//    so we don’t hammer the MLB API on every run.
// 2) If no cache, fall back to the MLB StatsAPI, then (optionally)
//    write a new cache row back to Supabase.
// -----------------------------------------------------------

/**
 * Get lifetime stats for a BATTER vs a specific PITCHER.
 * Returns an object such as:
 * {
 *   pa, ab, hits, home_runs, strikeouts, walks,
 *   avg, obp, slg, ops
 * }
 * or `null` if no data.
 */
export async function getBatterVsPitcherStats(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;

  /* 1️⃣  Try cached row first */
  const { data: cached } = await supabase
    .from("batter_vs_pitcher_stats")
    .select("*")
    .eq("batter_id", batterId)
    .eq("pitcher_id", pitcherId)
    .maybeSingle();

  if (cached) return cached; // ✅ cache hit

  /* 2️⃣  Fallback to live StatsAPI */
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const json = await res.json();
    const stat = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return null;

    const record = {
      batter_id: batterId,
      pitcher_id: pitcherId,
      pa: parseInt(stat.plateAppearances ?? 0, 10),
      ab: parseInt(stat.atBats ?? 0, 10),
      hits: parseInt(stat.hits ?? 0, 10),
      home_runs: parseInt(stat.homeRuns ?? 0, 10),
      strikeouts: parseInt(stat.strikeOuts ?? 0, 10),
      walks: parseInt(stat.baseOnBalls ?? 0, 10),
      avg: stat.avg ? parseFloat(stat.avg) : null,
      obp: stat.obp ? parseFloat(stat.obp) : null,
      slg: stat.slg ? parseFloat(stat.slg) : null,
      ops: stat.ops ? parseFloat(stat.ops) : null,
    };

    /* Optional: cache it */
    const { error: cacheErr } = await supabase
      .from("batter_vs_pitcher_stats")
      .insert([record]);

    if (cacheErr && process.env.DEBUG_BVP === "true") {
      console.warn("⚠️  BvP cache insert error:", cacheErr.message);
    }

    return record;
  } catch (err) {
    console.warn(
      `⚠️  Exception in BvP fetch for ${batterId} vs ${pitcherId}`,
      err
    );
    return null;
  }
}

/** Pitcher-vs-Batter: just reverse the IDs */
export async function getPitcherVsBatterStats(pitcherId, batterId) {
  return getBatterVsPitcherStats(batterId, pitcherId);
}

export async function getOpponentAbbreviation(teamAbbr, game_id) {
  const boxscore = await getBoxscoreFromGameID(game_id);
  const homeTeamId = boxscore?.teams?.home?.team?.id;
  const awayTeamId = boxscore?.teams?.away?.team?.id;

  const homeAbbr = getFullTeamAbbreviationFromID(homeTeamId);
  const awayAbbr = getFullTeamAbbreviationFromID(awayTeamId);

  if (homeAbbr === teamAbbr) return awayAbbr;
  if (awayAbbr === teamAbbr) return homeAbbr;

  console.warn(`⚠️ Team ${teamAbbr} not found in game ${game_id}`);
  return null;
}
