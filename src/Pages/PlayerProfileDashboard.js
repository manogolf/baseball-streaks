import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getBaseURL } from "../scripts/shared/getBaseURL.js";
import { getPropDisplayLabel } from "../scripts/shared/propUtils.js";

export default function PlayerProfileDashboard() {
  const { playerId } = useParams();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProfile() {
      console.log("🔍 Fetching profile for playerId:", playerId);
      try {
        const response = await fetch(
          `${getBaseURL()}/player-profile/${playerId}`
        );
        const data = await response.json();
        setProfile(data);
      } catch (err) {
        console.error("Error fetching player profile:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchProfile();
  }, [playerId]);

  if (loading) return <div className="p-4">Loading...</div>;
  if (!profile)
    return <div className="p-4 text-red-600">Profile not found.</div>;

  // ✅ Helper function defined outside return block
  const renderStatBlock = (title, stat) => {
    if (!stat) return null;

    return (
      <section className="mb-6">
        <h2 className="text-xl font-semibold mb-2">{title}</h2>
        <ul className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
          <li>
            AVG / OBP / SLG: {stat.avg} / {stat.obp} / {stat.slg}
          </li>
          <li>OPS: {stat.ops}</li>
          <li>Games Played: {stat.gamesPlayed}</li>
          <li>
            Hits / At-Bats: {stat.hits} / {stat.atBats}
          </li>
          <li>
            HR / RBI / Runs: {stat.homeRuns} / {stat.rbi} / {stat.runs}
          </li>
          <li>
            Strikeouts / Walks: {stat.strikeOuts} / {stat.baseOnBalls}
          </li>
          <li>
            SB / CS: {stat.stolenBases} / {stat.caughtStealing}
          </li>
          <li>Total Bases: {stat.totalBases}</li>
          <li>Plate Appearances: {stat.plateAppearances}</li>
          <li>
            Ground Outs / Air Outs: {stat.groundOuts} / {stat.airOuts}
          </li>
        </ul>
      </section>
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">
          Player Profile: {profile.player_name || profile.player_id}{" "}
          <span className="text-sm font-normal text-gray-500">
            ({profile.team})
          </span>
        </h1>
        <Link to="/players" className="text-blue-600 hover:underline text-sm">
          ← Back to Player List
        </Link>
      </div>

      <section className="mb-6">
        <h2 className="text-xl font-semibold mb-2">Current Streaks</h2>
        {profile.streaks?.length > 0 ? (
          <ul className="list-disc list-inside">
            {profile.streaks.map((s, i) => (
              <li key={i}>
                {getPropDisplayLabel(s.prop_type)}: {s.streak_type} streak of{" "}
                {s.streak_count}
              </li>
            ))}
          </ul>
        ) : (
          <p>No current streaks found.</p>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-xl font-semibold mb-2">Recent Props</h2>
        {profile.recent_props?.length > 0 ? (
          <ul className="space-y-1">
            {profile.recent_props.map((prop, i) => (
              <li key={i} className="border p-2 rounded">
                {prop.game_date}: {getPropDisplayLabel(prop.prop_type)} →{" "}
                {prop.outcome}
                {prop.over_under && prop.prop_value != null && (
                  <span className="text-sm text-gray-500">
                    {" "}
                    ({prop.over_under} {prop.prop_value})
                  </span>
                )}
                {prop.confidence_score && (
                  <span className="text-sm text-blue-600 ml-2">
                    {Math.round(prop.confidence_score * 100)}% confident
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>No recent props available.</p>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-xl font-semibold mb-2">Stat-Derived Props</h2>
        {profile.stat_derived_props?.length > 0 ? (
          <ul className="space-y-1">
            {profile.stat_derived_props.map((prop, i) => (
              <li key={i} className="border p-2 rounded">
                {prop.game_date}: {getPropDisplayLabel(prop.prop_type)} →{" "}
                {prop.result}
                {prop.outcome && (
                  <span className="text-sm text-gray-600 ml-2">
                    ({prop.outcome})
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>No stat-derived props recorded.</p>
        )}
      </section>

      <section className="mb-6">
        <h2 className="text-xl font-semibold mb-2">Training Summary</h2>
        {profile.training_summary?.length > 0 ? (
          <ul className="list-disc list-inside">
            {profile.training_summary.map((entry, i) => (
              <li key={i}>
                {getPropDisplayLabel(entry.prop_type)}: {entry.count} props used
                in training
              </li>
            ))}
          </ul>
        ) : (
          <p>No training data recorded.</p>
        )}
      </section>

      {renderStatBlock("Season Stats", profile.season_stats?.hitting)}
      {renderStatBlock("Career Stats", profile.career_stats?.hitting)}
    </div>
  );
}
