// src/shared/resolvePlayerAndTeam.js

import { supabase } from "../utils/supabaseFrontend.js";

// First, try player_ids; then fallback to model_training_props
export async function resolveTeamId(player_id) {
  if (!player_id) return null;

  // Try from player_ids table first
  const { data: direct, error: err1 } = await supabase
    .from("player_ids")
    .select("team_id")
    .eq("player_id", player_id)
    .not("team_id", "is", null) // ✅ ignore nulls
    .limit(1)
    .then((res) => ({ data: res.data?.[0], error: res.error }));

  if (err1) {
    console.error("❌ player_ids error:", err1.message);
  }

  console.log("🧱 player_ids returned:", direct);

  if (direct?.team_id != null) {
    console.log("✅ Found team_id in player_ids:", direct.team_id);
    return direct.team_id;
  }

  // Fallback to model_training_props with nulls excluded
  const { data: fallback, error: err2 } = await supabase
    .from("model_training_props")
    .select("team_id")
    .eq("player_id", player_id)
    .not("team_id", "is", null) // ✅ must use not(...) here
    .order("game_date", { ascending: false })
    .limit(1);

  if (err2) {
    console.error("❌ model_training_props error:", err2.message);
    return null;
  }

  console.log("🧱 model_training_props returned:", fallback);
  console.log("🧱 model_training_props full fallback data:", fallback);
  console.log("🧪 typeof fallback:", typeof fallback);
  console.log("🧪 fallback?.[0]:", fallback?.[0]);
  console.log("🧪 fallback?.[0]?.team_id:", fallback?.[0]?.team_id);

  const fallbackTeamId = fallback?.[0]?.team_id ?? null;
  console.log("🔁 resolveTeamId returning fallback:", fallbackTeamId);

  return fallbackTeamId;
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
