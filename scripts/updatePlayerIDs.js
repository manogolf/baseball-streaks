import { supabase } from "../utils/supabaseUtils.js";
import fetch from "node-fetch";

// Supabase client setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MLB_TEAMS_API = "https://statsapi.mlb.com/api/v1/teams?sportId=1";

async function fetchActivePlayers() {
  const teamsRes = await fetch(MLB_TEAMS_API);
  const teamsData = await teamsRes.json();

  const teams = teamsData.teams || [];
  const allPlayers = [];

  for (const team of teams) {
    const rosterUrl = `https://statsapi.mlb.com/api/v1/teams/${team.id}/roster/Active`;
    const rosterRes = await fetch(rosterUrl);
    const rosterData = await rosterRes.json();

    (rosterData.roster || []).forEach((player) => {
      allPlayers.push({
        player_name: player.person.fullName,
        team: team.abbreviation,
        player_id: player.person.id,
      });
    });
  }

  return allPlayers;
}

async function updatePlayerIDs() {
  const players = await fetchActivePlayers();

  for (const player of players) {
    const { error } = await supabase
      .from("player_ids")
      .upsert(player, { onConflict: ["player_name", "team"] });

    if (error) {
      console.error(
        `❌ Failed to upsert ${player.player_name}:`,
        error.message
      );
    } else {
      console.log(`✅ Upserted: ${player.player_name} (${player.team})`);
    }
  }

  console.log("🎉 Player ID sync complete.");
}

updatePlayerIDs();
