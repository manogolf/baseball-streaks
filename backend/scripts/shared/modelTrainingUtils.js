// backend/scripts/shared/modelTrainingUtils.js

import { supabase } from "./supabaseUtils.js";
import crypto from "node:crypto";
import { toISODate } from "./timeUtils.js";
import { getRollingAverage } from "./propUtils.js";
import { getStreaksForPlayer } from "./playerUtils.js";

// ⏩ Copies user-added props from player_props → model_training_props
export async function copyUserAddedPropsToTraining(sinceDaysAgo = 7) {
  console.log("📤 Syncing user-added props to model_training_props...");

  const sinceDate = toISODate(new Date(Date.now() - sinceDaysAgo * 86400000));

  const { data: props, error } = await supabase
    .from("player_props")
    .select(
      `
        id, player_id, player_name, team, position, prop_type, prop_value,
        result, outcome, over_under, is_pitcher, game_date, game_id,
        status, predicted_outcome, confidence_score, was_correct,
        prediction_timestamp, game_time, opponent, prop_source
      `
    )
    .eq("prop_source", "user_added")
    .in("status", ["win", "loss", "push"])
    .gte("game_date", sinceDate);

  if (error) {
    console.error("❌ Failed to fetch user-added props:", error.message);
    return;
  }

  const seen = new Set();
  const rows = [];

  for (const p of props) {
    if (!p.player_id || seen.has(p.id)) continue;
    seen.add(p.id);

    const rollingAvg = await getRollingAverage(
      p.player_id,
      p.prop_type,
      p.game_date
    );

    const lineDiff =
      typeof rollingAvg === "number" && typeof p.prop_value === "number"
        ? rollingAvg - p.prop_value
        : null;

    const streaks = await getStreaksForPlayer(p.player_id, p.prop_type);

    rows.push({
      ...p,
      id: p.id,
      prop_source: "user_added",
      rolling_result_avg_7: rollingAvg,
      line_diff: lineDiff,
      hit_streak: streaks?.hit_streak ?? null,
      win_streak: streaks?.win_streak ?? null,
    });
  }

  if (rows.length === 0) {
    console.log("✅ No new user-added props to sync.");
    return;
  }

  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error: insertError } = await supabase
      .from("model_training_props")
      .upsert(chunk, { onConflict: "id" });

    if (insertError) {
      console.error(
        `❌ Insert error on chunk starting at ${i}:`,
        insertError.message
      );
    } else {
      console.log(`✅ Synced ${chunk.length} user-added props.`);
    }
  }
}
