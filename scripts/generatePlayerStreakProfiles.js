// scripts/generatePlayerStreakProfiles.js
import "dotenv/config";
import { supabase } from "./shared/supabaseUtils.js";
import { DateTime } from "luxon";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchResolvedProps() {
  const { data, error } = await supabase
    .from("player_props")
    .select("player_id, prop_type, outcome, game_date")
    .not("outcome", "is", null)
    .not("player_id", "is", null) // ✅ skip rows missing player_id
    .order("game_date", { ascending: true });

  if (error) throw new Error("Error fetching resolved props: " + error.message);
  return data;
}

function analyzeStreaks(props) {
  const streaks = {};

  for (const prop of props) {
    const key = `${prop.player_id}_${prop.prop_type}`;
    if (!streaks[key]) {
      streaks[key] = {
        player_id: prop.player_id,
        prop_type: prop.prop_type,
        outcomes: [],
      };
    }
    streaks[key].outcomes.push({
      date: prop.game_date,
      outcome: prop.outcome,
    });
  }

  return Object.values(streaks).map((entry) => {
    const outcomes = entry.outcomes;
    let currentStreak = 1;
    const lastOutcome = outcomes[outcomes.length - 1].outcome;
    const direction = lastOutcome === "win" ? "hot" : "cold";

    for (let i = outcomes.length - 2; i >= 0; i--) {
      if (outcomes[i].outcome === lastOutcome) currentStreak++;
      else break;
    }

    return {
      player_id: entry.player_id,
      prop_type: entry.prop_type,
      streak_count: currentStreak,
      streak_type: direction, // 'hot' or 'cold'
      last_game_date: outcomes[outcomes.length - 1].date,
      last_outcome: lastOutcome,
      recent_outcomes: outcomes.slice(-10).map((o) => o.outcome),
      updated_at: DateTime.now().toISO(),
    };
  });
}

async function upsertStreaks(streakProfiles) {
  const { error } = await supabase
    .from("player_streak_profiles")
    .upsert(streakProfiles, { onConflict: ["player_id", "prop_type"] });

  if (error)
    throw new Error("Error upserting streak profiles: " + error.message);
}

(async () => {
  try {
    console.log("📥 Fetching resolved props...");
    const props = await fetchResolvedProps();
    console.log(`🔍 Found ${props.length} resolved props.`);

    console.log("🧠 Analyzing streaks...");
    const streaks = analyzeStreaks(props);

    console.log(`⬆️ Upserting ${streaks.length} streak profiles...`);
    await upsertStreaks(streaks);

    console.log("✅ Done.");
  } catch (err) {
    console.error("🔥 Failed:", err);
    process.exit(1);
  }
})();
