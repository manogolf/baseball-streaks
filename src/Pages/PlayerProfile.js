import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

export default function PlayerProfilePage() {
  const { playerId } = useParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchProfile() {
      try {
        const response = await fetch(
          `${
            process.env.REACT_APP_API_URL || "http://localhost:8001"
          }/player-profile/${playerId}`
        );
        if (!response.ok) throw new Error("Failed to fetch profile");
        const data = await response.json();
        setProfile(data);
      } catch (err) {
        console.error("❌ Error fetching profile:", err);
        setError("Could not load player profile.");
      } finally {
        setLoading(false);
      }
    }

    fetchProfile();
  }, [playerId]);

  if (loading) return <div className="p-4">Loading profile...</div>;
  if (error) return <div className="p-4 text-red-600">{error}</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Player Profile</h1>
      <p className="mb-2">
        🔢 <strong>Player ID:</strong> {profile.player_id}
      </p>
      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-2">Current Streak</h2>
        <p>
          {profile.streak.count}{" "}
          {profile.streak.type === "win"
            ? "✅ Wins"
            : profile.streak.type === "loss"
            ? "❌ Losses"
            : "Neutral"}
        </p>
      </div>
      <div>
        <h2 className="text-xl font-semibold mb-2">Recent Props</h2>
        <ul className="space-y-1">
          {profile.recent_props.map((prop) => (
            <li
              key={prop.id}
              className="border border-gray-200 rounded px-3 py-2"
            >
              <strong>{prop.prop_type}</strong> — {prop.outcome} on{" "}
              {prop.game_date}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
