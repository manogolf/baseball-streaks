// src/shared/resolvePlayerAndTeam.js

import { supabase } from "../utils/supabaseFrontend.js";

// First, try player_ids; then fallback to model_training_props
export async function resolveTeamId(player_id) {
  if (!player_id) return null;

  const { data: direct, error: err1 } = await supabase
    .from("player_ids")
    .select("team_id")
    .eq("player_id", player_id)
    .maybeSingle();

  if (err1) {
    console.error("❌ player_ids error:", err1.message);
  }
  if (direct && direct.team_id != null) return direct.team_id;
  console.log(
    "🔁 resolveTeamId returning fallback:",
    fallback?.[0]?.team_id ?? null
  );

  const { data: fallback, error: err2 } = await supabase
    .from("model_training_props")
    .select("team_id")
    .eq("player_id", player_id)
    .order("game_date", { ascending: false })
    .limit(1);

  if (err2) {
    console.error("❌ model_training_props error:", err2.message);
    return null;
  }

  return fallback?.[0]?.team_id ?? null;
}

// 🔁 Full resolver used in PlayerPropForm
export async function resolvePlayerAndTeam({ player_name, team_abbr }) {
  const { data, error } = await supabase
    .from("player_ids")
    .select("player_id")
    .ilike("player_name", player_name)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ Error resolving player_id:", error.message);
    return { player_id: null, team_id: null };
  }

  const player_id = data?.player_id ?? null;
  const team_id = await resolveTeamId(player_id);

  return { player_id, team_id };
}
