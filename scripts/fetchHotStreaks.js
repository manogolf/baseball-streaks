// src/scripts/fetchHotStreaks.js

import { supabase } from "../src/utils/supabaseUtils.js";
import fetch from "node-fetch";

// Settings
const LOOKBACK_GAMES = 25; // Look back further

const trackedStreaks = [
  { category: "hits", group: "hitting", minGames: 2 }, // 2 hits games in a row
  { category: "strikeouts", group: "pitching", minGames: 2 }, // 2 strikeout games
  { category: "homeRuns", group: "hitting", minGames: 1 }, // just 1 game with a homer!
  { category: "walks", group: "hitting", minGames: 2 }, // 2 walks games
];

export async function fetchHotStreaks() {
  console.log("🚀 Fetching MLB Streaks...");

  try {
    const streakResults = [];

    // Loop through each streak type
    for (const { category, group, minGames } of trackedStreaks) {
      console.log(`🔎 Fetching leaders for ${category}...`);

      const res = await fetch(
        `https://statsapi.mlb.com/api/v1/stats/leaders?leaderCategories=${category}&season=2025&limit=50&hydrate=person,team,league`
      );
      const data = await res.json();
      const leaders = data?.stats?.[0]?.leaders || [];

      for (const player of leaders) {
        const playerId = player.person.id;
        const playerName = player.person.fullName;
        const teamName = player.team?.name || "Unknown";

        const gameLogRes = await fetch(
          `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=2025&group=${group}`
        );
        const gameLogData = await gameLogRes.json();
        const games = gameLogData.stats?.[0]?.splits || [];

        let streak = 0;
        for (let i = 0; i < Math.min(LOOKBACK_GAMES, games.length); i++) {
          const stat = games[i]?.stat;
          if (!stat) continue;

          const value = stat[category] ?? 0;
          if (
            (category === "strikeouts" && value >= 5) ||
            (category !== "strikeouts" && value > 0)
          ) {
            streak++;
          } else {
            break;
          }
        }

        if (streak >= minGames) {
          streakResults.push({
            player_name: playerName,
            team: teamName,
            prop_type: capitalizeFirstLetter(category),
            current_streak: streak,
            last_updated: new Date().toISOString(),
          });
        }
      }
    }

    // Pull all previously active streaks
    const { data: existingStreaks, error: fetchError } = await supabase
      .from("mlb_live_streaks")
      .select("*")
      .eq("is_active", true);

    if (fetchError) {
      console.error("❌ Error fetching existing streaks:", fetchError.message);
      return;
    }

    // Create maps for easier lookups
    const activeStreaksMap = new Map();
    if (existingStreaks) {
      for (const streak of existingStreaks) {
        activeStreaksMap.set(
          `${streak.player_name}_${streak.prop_type}`,
          streak
        );
      }
    }

    // Determine who is still streaking and who broke
    const today = new Date().toISOString();
    const stillStreakingSet = new Set();

    for (const streak of streakResults) {
      stillStreakingSet.add(`${streak.player_name}_${streak.prop_type}`);
    }

    // Prepare batch updates
    const updates = [];

    // (1) Insert or update all current streaks
    for (const streak of streakResults) {
      updates.push({
        ...streak,
        is_active: true,
        streak_broken_date: null,
      });
    }

    // (2) Mark old streaks as broken
    for (const [key, streak] of activeStreaksMap.entries()) {
      if (!stillStreakingSet.has(key)) {
        updates.push({
          id: streak.id, // IMPORTANT: ensure you have "id" field in mlb_live_streaks
          player_name: streak.player_name,
          prop_type: streak.prop_type,
          is_active: false,
          streak_broken_date: today,
          last_updated: today,
        });
      }
    }

    // 🚀 Batch upsert
    const { error: upsertError } = await supabase
      .from("mlb_live_streaks")
      .upsert(updates, { onConflict: ["player_name", "prop_type"] });

    if (upsertError) {
      console.error("❌ Error saving updated streaks:", upsertError.message);
    } else {
      console.log(
        `✅ Streaks updated successfully. Active: ${
          streakResults.length
        }, Broken: ${updates.length - streakResults.length}`
      );
    }
  } catch (error) {
    console.error("❌ Error fetching hot streaks:", error.message);
  }
}

function capitalizeFirstLetter(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// 🔥 Auto-run if direct called (optional)
fetchHotStreaks();
