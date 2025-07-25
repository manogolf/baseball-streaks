import { supabase } from "../scripts/shared/supabaseBackend.js";

export default async function preparePropSubmission({
  playerName,
  teamAbbr,
  propType,
  line,
  overUnder,
  gameDate,
}) {
  console.log("🛠️ preparePropSubmission called with:", {
    playerName,
    teamAbbr,
    propType,
    line,
    overUnder,
    gameDate,
  });

  if (
    !playerName ||
    !teamAbbr ||
    !propType ||
    line == null ||
    !overUnder ||
    !gameDate
  ) {
    return {
      error: "Missing one or more required fields.",
    };
  }

  // ✅ Resolve player_id from existing data
  const { data: playerMatch, error } = await supabase
    .from("model_training_props")
    .select("player_id")
    .eq("player_name", playerName)
    .eq("team", teamAbbr)
    .maybeSingle();

  if (error || !playerMatch) {
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
    player_id: playerMatch.player_id,
  };

  return prepared;
}
