import { getPlayerStatsFromBoxscore } from "../src/utils/fetchBoxscoreStats.js";

const test = async () => {
  const stats = await getPlayerStatsFromBoxscore({
    game_id: 777639, // Replace if needed
    player_id: 668942, // Josh Rojas
  });
  console.log("📊 Boxscore stats returned:", stats);
};

test();
