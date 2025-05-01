import { useEffect } from 'react';
import { supabase } from '../utils/supabaseClient.js';

const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';

const useLivePropStatus = () => {
  useEffect(() => {
    const interval = setInterval(checkLiveProps, 90 * 1000); // every 90 seconds

    async function checkLiveProps() {
      const today = new Date().toISOString().split('T')[0];

      // 1. Get today's player props (filtering for live or pending "Hits" props)
      const { data: props, error } = await supabase
        .from('player_props')
        .select('*')
        .eq('game_date', today)
        .eq('prop_type', 'Hits')
        .in('status', ['Pending', 'Live']);

      if (error) {
        console.error('Error fetching props:', error);
        return;
      }

      // 2. Loop through the props to check live data
      for (const prop of props) {
        try {
          const gameId = prop.game_id;
          const playerId = prop.player_id;
          const propValue = prop.prop_value;

          // 3. Fetch live boxscore data for the player's game
          const res = await fetch(`${MLB_BASE_URL}/game/${gameId}/boxscore`);
          const json = await res.json();

          if (!json || !json?.teams?.home) {
            throw new Error(`No valid data found for game ${gameId}`);
          }

          // 4. Find player and their stats
          const allPlayers = {
            ...json?.teams?.home?.players,
            ...json?.teams?.away?.players,
          };

          const playerKey = `ID${playerId}`;
          const playerStats = allPlayers?.[playerKey]?.stats?.batting;
          const hits = playerStats?.hits ?? 0;

          // 5. Determine the new status based on the player's live performance
          let newStatus = 'Live';
          if (hits >= propValue) {
            newStatus = 'Won';
          } else if (json.gameData.status.abstractGameState === 'Final') {
            newStatus = 'Missed';
          }

          // 6. Update the player's prop status in the database
          if (newStatus !== prop.status) {
            const { error: updateError } = await supabase
              .from('player_props')
              .update({ status: newStatus })
              .eq('id', prop.id);

            if (updateError) {
              console.error(`Error updating prop ID ${prop.id}:`, updateError.message);
            }
          }
        } catch (err) {
          console.error(`Error processing prop ID ${prop.id}:`, err.message);
        }
      }
    }

    return () => clearInterval(interval);
  }, []);
};

export default useLivePropStatus;
