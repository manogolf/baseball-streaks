import { createClient } from "@supabase/supabase-js";
import { nowET, todayET, currentTimeET } from "./timeUtils.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function fetchResolvedProps() {
  const { data, error } = await supabase
    .from("player_props")
    .select("*")
    .eq("status", "resolved");

  if (error) {
    console.error("❌ Failed to fetch resolved props:", error.message);
    return [];
  }
  return data;
}

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

export async function updatePropStatuses(updatePropStatusFn) {
  const props = await getPendingProps();
  console.log(`🔎 Found ${props.length} pending props to update.`);

  let updated = 0,
    skipped = 0,
    errors = 0;

  for (const prop of props) {
    try {
      const success = await updatePropStatusFn(prop);
      if (success) updated++;
      else skipped++;
    } catch (err) {
      console.error(`🔥 Error processing ${prop.player_name}:`, err.message);
      errors++;
    }
  }

  await expireOldPendingProps();

  console.log(
    `🏁 Status Update Complete — Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`
  );
}

export async function syncTrainingData() {
  const resolvedProps = await fetchResolvedProps();

  for (const prop of resolvedProps) {
    const upsertData = {
      id: prop.id,
      game_date: prop.game_date,
      player_name: prop.player_name,
      team: prop.team,
      position: prop.position,
      prop_type: prop.prop_type,
      prop_value: prop.prop_value,
      result: prop.result,
      outcome: prop.outcome,
      is_pitcher: prop.is_pitcher,
      streak_count: prop.streak_count,
      over_under: prop.over_under,
      status: prop.status,
      game_id: prop.game_id,
      opponent: prop.opponent,
      home_away: prop.home_away,
      game_time: prop.game_time,
      player_id: prop.player_id,
      predicted_outcome: prop.predicted_outcome || null,
      confidence_score: prop.confidence_score || null,
      prediction_timestamp: prop.prediction_timestamp || null,
      was_correct: prop.was_correct || null,
      prop_source: prop.prop_source || "user-added",
    };

    const { error: upsertError } = await supabase
      .from("model_training_props")
      .upsert(upsertData, { onConflict: ["id"] });

    if (upsertError) {
      console.error(
        `❌ Failed to upsert prop ${prop.id}:`,
        upsertError.message
      );
    } else {
      console.log(`✅ Synced prop ${prop.id} to model_training_props`);
    }
  }
}
