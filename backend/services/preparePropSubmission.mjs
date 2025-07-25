// File: backend/api/preparePropSubmission.js

import { supabase } from "../scripts/shared/supabaseBackend.js";
import { getPlayerID } from "../scripts/shared/playerUtilsBackend.js"; // <- this must be the backend-safe version

export default async function preparePropSubmission({
  playerName,
  teamAbbr,
  propType,
  line,
  overUnder,
  gameDate,
  game_id,
}) {
  console.log("🛠️ preparePropSubmission called with:", {
    playerName,
    teamAbbr,
    propType,
    line,
    overUnder,
    gameDate,
    game_id,
  });

  if (
    !playerName ||
    !teamAbbr ||
    !propType ||
    line == null ||
    !overUnder ||
    !gameDate
  ) {
    return { error: "Missing one or more required fields." };
  }

  // ✅ Resolve player_id using clean util
  const player_id = await getPlayerID(
    supabase,
    playerName,
    teamAbbr,
    game_id // optional in your current getPlayerID but passed just in case
  );

  if (!player_id) {
    console.warn("⚠️ Failed to resolve player_id for:", playerName, teamAbbr);
    return {
      error: "Could not resolve player ID. Please check player name and team.",
    };
  }

  const prepared = {
    player_name: playerName,
    team: teamAbbr,
    prop_type: propType,
    prop_value: parseFloat(line),
    over_under: overUnder.toLowerCase(),
    game_date: gameDate,
    game_id,
    player_id,
  };

  console.log("📦 Prepared prop submission:", prepared);
  return prepared;
}
