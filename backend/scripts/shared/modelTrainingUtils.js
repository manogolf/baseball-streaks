// backend/scripts/shared/modelTrainingUtils.js
import crypto from "node:crypto";
import { supabase } from "./supabaseBackend.js";
import {
  normalizePropType,
  getRollingAverage,
  determineOpponent,
} from "../../../shared/propUtils.js";
import { getStreaksForPlayer } from "./playerUtilsBackend.js";
import { getTeamIdFromAbbr } from "../../../shared/teamNameMap.js";

/**
 * Up-sert all user-added props from `player_props` into `model_training_props`.
 *
 * @param {object} opts
 * @param {number} opts.batchSize   – rows per pull from Supabase (default 1 000)
 * @param {number} opts.daysBack    – look-back window in days; 0 = all time
 *                                    (handy for daily crons: daysBack = 1-3,
 *                                    or a larger value if you missed runs)
 */
export async function upsertUserPropsToTraining(opts = {}) {
  const {
    batchSize = 1_000,
    daysBack = 0, // 0 ⇒ no date filter (all rows)
  } = opts;

  console.log(
    `🔁 Re-syncing user-added props into model_training_props (batch ${batchSize}, daysBack ${daysBack})`
  );

  // ① Calculate optional date cutoff
  let dateCutoff = null;
  if (daysBack > 0) {
    dateCutoff = new Date(Date.now() - daysBack * 86_400_000)
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD
  }

  let offset = 0;
  let totalProcessed = 0;
  const timerStart = Date.now();

  while (true) {
    /* ---------------- fetch a batch ---------------- */
    let query = supabase
      .from("player_props")
      .select(
        `
          id, player_id, player_name, team, position, prop_type, prop_value,
          result, outcome, over_under, is_pitcher, game_date, game_id,
          status, predicted_outcome, confidence_score, was_correct,
          prediction_timestamp, prop_source
        `
      )
      .eq("prop_source", "user_added")
      .in("status", ["win", "loss", "push"])
      .order("game_date", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (dateCutoff) query = query.gte("game_date", dateCutoff);

    const { data: props, error } = await query;

    if (error) {
      console.error("❌ Fetch error:", error.message);
      break;
    }

    if (!props?.length) {
      console.log("✅ Sync complete - no more rows.");
      break;
    }

    /* ---------- enrich each row (rolling avg, streaks…) ---------- */
    const rowsToUpsert = [];

    for (const p of props) {
      if (!p.player_id || !p.game_date) {
        console.warn(
          `⚠️ Skipping row missing player_id / game_date (id: ${p.id})`
        );
        continue;
      }

      const propTypeNorm = normalizePropType(p.prop_type);

      // Recent 7-game rolling average
      const rollingAvg = await getRollingAverage(
        supabase,
        p.player_id,
        propTypeNorm,
        p.game_date,
        p.game_id,
        7
      );

      // Simple line-diff helper
      const lineDiff =
        typeof rollingAvg === "number" && typeof p.prop_value === "number"
          ? rollingAvg - p.prop_value
          : null;

      // Current streak (may return undefined / null)
      const streaks = await getStreaksForPlayer(
        supabase,
        p.player_id,
        propTypeNorm
      );
      const opponent = await determineOpponent(
        supabase,
        p.player_id,
        p.game_id
      );
      const opponent_encoded = opponent ? getTeamIdFromAbbr(opponent) : null;

      rowsToUpsert.push({
        ...p,
        id: crypto.randomUUID(),
        prop_type: propTypeNorm,
        rolling_result_avg_7: rollingAvg ?? null,
        line_diff: lineDiff,
        hit_streak: streaks?.hit_streak ?? null,
        win_streak: streaks?.win_streak ?? null,
        opponent: opponent ?? null,
        opponent_encoded: p.opponent_encoded ?? opponent_encoded, // ✅ safe override
      });
    }

    console.log(`📦 Prepared ${rowsToUpsert.length} rows (offset ${offset})`);

    /* ---------------- bulk upsert ---------------- */

    const deduped = Array.from(
      new Map(
        rowsToUpsert.map((r) => [
          `${r.player_id}-${r.game_id}-${r.prop_type}-${r.prop_source}`,
          r,
        ])
      ).values()
    );

    if (rowsToUpsert.length) {
      const { error: upsertErr } = await supabase
        .from("model_training_props")
        .upsert(deduped, {
          onConflict: "player_id, game_id, prop_type, prop_source",
        });

      const stamp = new Date().toISOString();
      if (upsertErr) {
        console.error(`❌ [${stamp}] Upsert error: ${upsertErr.message}`);
      } else {
        console.log(
          `✅ [${stamp}] Upserted ${rowsToUpsert.length} rows (offset ${offset})`
        );
        totalProcessed += rowsToUpsert.length;
      }
    }

    // next page
    offset += batchSize;
  }

  const secs = ((Date.now() - timerStart) / 1000).toFixed(1);
  console.log(`🎉 Sync finished. Processed ${totalProcessed} rows in ${secs}s`);
}
