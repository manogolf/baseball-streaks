import React, { useState, useEffect } from "react";
import TodayGames from "../components/GameCardTest";
import StreakCard from "../components/StreakCard";

export default function Home() {
  const [games, setGames] = useState([]);

  useEffect(() => {
    const fetchGames = async () => {
      try {
        const today = new Date().toISOString().split("T")[0];
        const response = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=team,linescore,probablePitcher,decisions,game(content(summary),live)`
        );
        const data = await response.json();
        const gameList = data.dates?.[0]?.games || [];
        setGames(gameList);
      } catch (error) {
        console.error("Error fetching games:", error);
      }
    };

    fetchGames();
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 px-4 py-6">
      <div className="max-w-4xl mx-auto bg-white rounded-xl shadow p-6 space-y-6">
        <TodayGames games={games} />
        <StreakCard />
      </div>
    </div>
  );
}
