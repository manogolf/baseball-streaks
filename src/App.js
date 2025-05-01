import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { getEasternDateString } from "./utils/getEasternDateString.js";
import useLivePropStatus from "./hooks/useLivePropStatus.js";

import PlayerPropsTable from "./components/PlayerPropsTable.js";
import PlayerPropForm from "./components/PlayerPropForm.js";
import TodayGames from "./components/TodayGames.js";
import StreaksCard from "./components/StreakCard.js";
import PropTracker from "./components/PropTracker.js";
import OwnerLogin from "./components/OwnerLogin.js";
// import LoginButton from './components/loginButton.js'; // optional

import "./App.css";

function App() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);

  useLivePropStatus();

  const fetchGames = async () => {
    try {
      const today = getEasternDateString();
      const res = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=linescore,boxscore,probablePitcher,team,team.record,gameContent,flags&_=${Date.now()}`
      );
      const data = await res.json();
      if (data && data.dates && data.dates[0]) {
        setGames(data.dates[0].games || []);
      } else {
        console.error("No game data found for today.");
      }
    } catch (err) {
      console.error("Failed to fetch games:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGames();
    const interval = setInterval(fetchGames, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Router>
      <div className="min-h-screen bg-gray-100 p-4">
        {/* HEADER */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-1">
            <h1 className="text-5xl font-bold text-indigo-900">
              P<sup className="text-2xl align-top">3</sup>roppadia
            </h1>
          </div>
          <div className="flex-1"></div>
          <div className="flex flex-col items-end space-y-1">
            <div className="text-lg text-gray-600 font-medium">
              Player Prop Predictions
            </div>
            <div className="text-sm text-gray-400">Powered by Momentum</div>
            {/* <LoginButton /> */}
          </div>
        </div>

        {/* ROUTES */}
        <Routes>
          <Route
            path="/"
            element={
              <div className="max-w-6xl mx-auto space-y-4">
                {/* Today’s Games */}
                <div className="bg-white rounded-2xl shadow p-4">
                  {loading ? (
                    <div className="text-center text-gray-500">
                      Loading games...
                    </div>
                  ) : (
                    <TodayGames games={games} />
                  )}
                </div>

                {/* Streaks */}
                <div className="bg-white rounded-2xl shadow p-4">
                  <StreaksCard />
                </div>

                {/* Tracker */}
                <div className="bg-white rounded-2xl shadow p-4">
                  <PropTracker />
                </div>

                {/* Props Table + Form */}
                <div className="bg-white rounded-2xl shadow p-4 space-y-2">
                  <PlayerPropsTable />
                  <PlayerPropForm />
                </div>
              </div>
            }
          />
          <Route path="/owner-login" element={<OwnerLogin />} />
        </Routes>

        {/* FOOTER */}
        <footer className="text-center text-gray-500 text-sm py-6">
          © 2025 P³ — Prop Predictions Powered by Momentum.
        </footer>
      </div>
    </Router>
  );
}

export default App;
