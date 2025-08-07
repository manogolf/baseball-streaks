//  src/components/PlayerPropForm.js

import { useEffect, useState } from "react";
import Select from "react-select";
import { resolvePlayerAndTeam } from "../shared/resolvePlayerAndTeam.js";
import { supabase } from "../utils/supabaseFrontend.js";
import { nowET, todayET } from "../shared/timeUtils.js";
import { useAuth } from "../context/AuthContext.js";
import { getPropTypeOptions } from "../../shared/propUtils.js";
import { enrichGameContext } from "../../shared/enrichGameContext.js";

//const isLocal = window.location.hostname === "localhost";
//const apiUrl = isLocal
//? "http://localhost:3001"
//: "https://baseball-streaks-sq44.onrender.com";

const apiUrl = "https://baseball-streaks-sq44.onrender.com";

// ✅ Unified resolution of player and team ID
const PlayerPropForm = ({ onPropAdded }) => {
  const today = todayET();
  const auth = useAuth();

  const [userId, setUserId] = useState(null);

  const [formData, setFormData] = useState({
    player_name: "",
    player_id: null,
    team: "",
    prop_type: "",
    prop_value: 0.5,
    over_under: "under",
    game_date: today,
  });

  const [context, setContext] = useState(null);
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    async function loadContext() {
      const { player_id, player_name, team, game_date } = formData;

      if (!player_id || !game_date) return;

      const { player_id: resolvedPlayerId, team_id: teamId } =
        await resolvePlayerAndTeam({
          player_id,
          player_name,
          team_abbr: team,
        });

      console.log("🔍 resolvePlayerAndTeam result:", {
        resolvedPlayerId,
        teamId,
      });

      if (!resolvedPlayerId) {
        console.warn(`⚠️ Could not resolve player_id`);
        return;
      }

      if (!teamId) {
        console.warn(
          `⚠️ Could not resolve team_id for player ${resolvedPlayerId}`
        );
        return;
      }

      try {
        const ctx = await enrichGameContext({
          team_id: teamId,
          gameDate: game_date,
        });

        const enrichedContext = {
          ...ctx,
          player_id: resolvedPlayerId,
          team_id: teamId,
        };

        setContext(enrichedContext);
      } catch (err) {
        console.error("❌ Failed to enrich game context:", err);
      }
    }

    loadContext();
  }, [
    formData.player_id,
    formData.player_name,
    formData.team,
    formData.game_date,
  ]);

  const [propTypes, setPropTypes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [prediction, setPrediction] = useState(null);
  const [successToast, setSuccessToast] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const propTypeOptions = getPropTypeOptions();
  const successMessages = [
    "🎯 Prediction ready — make your move!",
    "🧠 Got a prediction — trust your gut!",
    "🚀 Data's in. Your turn to shine!",
    "📈 Looks promising! Place your prop wisely.",
    "🔥 Prediction locked — time to go big!",
  ];

  /**
   * 🔐 Fetch the logged‑in user once on mount
   */
  useEffect(() => {
    const fetchUser = async () => {
      // Try context first
      if (auth?.user?.id) {
        setUserId(auth.user.id);
        return;
      }

      // Fallback to direct Supabase call
      const { data, error } = await supabase.auth.getUser();
      if (data?.user) setUserId(data.user.id);
    };
    fetchUser();
  }, [auth?.user]);

  /**
   * 📜 Load prop‑type dropdown once
   */
  useEffect(() => {
    const fetchPropTypes = async () => {
      const { data, error } = await supabase.from("prop_types").select("name");
      if (!error && data) setPropTypes(data.map((item) => item.name));
    };
    fetchPropTypes();
  }, []);

  useEffect(() => {
    const fetchPlayers = async () => {
      const { data, error } = await supabase
        .from("player_ids")
        .select("player_id, player_name")
        .order("player_name", { ascending: true });

      if (!error && data) {
        setPlayers(data);
      }
    };

    fetchPlayers();
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  /**
   * 🧠 Predict outcome (unchanged logic)
   */
  const handlePredict = async () => {
    setSubmitting(true);
    setError(null);

    try {
      // 🧩 Validate input
      if (!formData.player_name || !formData.team || !formData.prop_type) {
        setError("Missing required form fields.");
        setSubmitting(false);
        return;
      }

      if (!context) {
        setError("Game context not ready yet.");
        setSubmitting(false);
        return;
      }

      // 🧠 Merge form + context
      const payload = {
        prop_type: formData.prop_type,
        features: {
          ...formData,
          ...context,
          prop_value: parseFloat(formData.prop_value), // ensure numeric
        },
      };

      console.log("📤 Submitting prediction payload:", payload);

      const res = await fetch(`${apiUrl}/api/predict`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload), // ✅ Correct: no extra wrapper
      });

      const json = await res.json();
      console.log("📊 Prediction result:", json);

      if (typeof json.probability === "number" && !isNaN(json.probability)) {
        const confidence = Math.round(json.probability * 100);
        const { player_id, team_id } = context;

        setPrediction({
          probability: json.probability,
          recommendation: json.recommendation,
          confidence,
          preparedProp: {
            ...payload.features, // not full payload, just features here
            player_id,
            team_id,
            game_id: context.game_id,
          },
        });
      } else {
        setError("Prediction failed: Invalid probability returned.");
      }
    } catch (err) {
      console.error("❌ Prediction Error:", err);
      setError("Prediction failed: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * ➕ Submit prop to Supabase
   */
  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    // 🛑 Ensure user is logged in
    if (!userId) {
      setError("You must be logged in to submit a prop.");
      setSubmitting(false);
      return;
    }

    try {
      // 👉 Step 1: Resolve MLB game ID
      const resolvedGameId = context?.game_id;
      if (!resolvedGameId) {
        setError("Game context missing game_id.");
        setSubmitting(false);
        return;
      }

      if (!resolvedGameId) {
        setError("Could not find a game for this team on the selected date.");
        setSubmitting(false);
        return;
      }

      // 🧠 Step 1: Merge all available data into one clean object
      const base = {
        player_name: formData.player_name,
        team: formData.team, // ✅ Use this for 'team' column in DB
        prop_type: formData.prop_type,
        prop_value: parseFloat(formData.prop_value),
        over_under: formData.over_under?.toLowerCase(),
        game_date: formData.game_date,
        user_id: userId,
        team_id: prediction.preparedProp?.team_id, // ✅ include team_id here
      };

      // 🧠 Step 2: Resolve player_id and team_id centrally
      const { player_id, team_id } = prediction.preparedProp;

      if (!player_id) {
        setError("❌ Missing player_id — cannot submit prop.");
        setSubmitting(false);
        return;
      }
      if (!team_id) {
        console.warn("⚠️ Could not resolve team_id for player", player_id);
      }

      if (!player_id) {
        setError("❌ Missing player_id — cannot submit prop.");
        setSubmitting(false);
        return;
      }
      if (!team_id) {
        console.warn("⚠️ Could not resolve team_id for player", player_id);
      }

      // 🧠 Step 3: Predict
      const predictRes = await fetch(`${apiUrl}/api/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prop_type: formData.prop_type,
          features: {
            ...base,
            player_id,
            team_id,
            game_id: resolvedGameId,
          },
        }),
      });
      const predictJson = await predictRes.json();

      if (!predictRes.ok || !predictJson || predictJson.error) {
        setError(
          "Prediction failed: " + (predictJson?.error ?? "unknown error")
        );
        setSubmitting(false);
        return;
      }

      // 🧠 Step 4: Build final submission
      const now = nowET().toISO();

      console.log("🔍 prediction before submission:", prediction);
      // Strip unsupported keys from context
      const { team_abbr, ...cleanContext } = context;

      const finalSubmission = {
        ...base,
        player_id,
        team_id,
        game_id: resolvedGameId,
        status: "pending",
        created_at: now,
        prediction_timestamp: now,
        prop_source: "user_added",
        predicted_outcome: predictJson.recommendation ?? null,
        confidence_score: predictJson.probability ?? null,
        ...cleanContext,
      };

      // ✅ Final insert
      const { error: insertError } = await supabase
        .from("player_props")
        .insert([finalSubmission]);

      if (insertError) {
        console.error("❌ Failed to insert prop:", insertError.message);
      } else {
        console.log("✅ Prop successfully submitted:", finalSubmission);
      }

      // ✅ Success
      console.log("✅ Prop successfully added to Supabase.");
      onPropAdded?.();
      setSuccessMessage("✅ Prop successfully added!");
      setSuccessToast(true);
      setFormData({
        player_name: "",
        team: "",
        prop_type: "",
        prop_value: 0.5,
        over_under: "under",
        game_date: today,
      });
      setPrediction(null);
      setTimeout(() => setSuccessToast(false), 4000);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 p-4 bg-blue-100 rounded-xl shadow-md overflow-x-auto w-full max-w-5xl mx-auto"
    >
      <h2 className="text-2xl font-bold text-center">📋 Add Player Prop</h2>
      <p className="text-gray-500 text-center text-sm">
        You must make a prediction before adding a prop.
      </p>
      {error && (
        <div className="bg-red-100 text-red-700 p-2 rounded-md text-center">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          options={players.map((p) => ({
            label: p.player_name,
            value: p.player_id,
          }))}
          value={
            formData.player_id
              ? {
                  label: formData.player_name,
                  value: formData.player_id,
                }
              : null
          }
          onChange={(selected) => {
            setFormData((prev) => ({
              ...prev,
              player_name: selected.label,
              player_id: selected.value,
            }));
          }}
          placeholder="Select Player"
          className="mb-4"
        />

        <select
          name="team"
          value={formData.team}
          onChange={handleChange}
          className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
        >
          <option value="">Select Team</option>
          {[
            "ATH",
            "ATL",
            "AZ",
            "BAL",
            "BOS",
            "CHC",
            "CWS",
            "CIN",
            "CLE",
            "COL",
            "DET",
            "HOU",
            "KC",
            "LAA",
            "LAD",
            "MIA",
            "MIL",
            "MIN",
            "NYM",
            "NYY",
            "PHI",
            "PIT",
            "SD",
            "SEA",
            "SF",
            "STL",
            "TB",
            "TEX",
            "TOR",
            "WSH",
          ].map((abbr) => (
            <option key={abbr} value={abbr}>
              {abbr}
            </option>
          ))}
        </select>

        <select
          id="prop_type"
          name="prop_type"
          value={formData.prop_type}
          onChange={handleChange}
          required
          className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
        >
          <option value="">Select a prop type</option>
          {propTypeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <input
          type="number"
          name="prop_value"
          value={formData.prop_value}
          onChange={handleChange}
          placeholder="Prop Value"
          className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
        />

        <select
          name="over_under"
          value={formData.over_under}
          onChange={handleChange}
          className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
        >
          <option value="">Select Over/Under</option>
          <option value="over">Over</option>
          <option value="under">Under</option>
        </select>

        <input
          type="date"
          name="game_date"
          value={formData.game_date}
          onChange={handleChange}
          className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
        />
      </div>
      <div className="flex space-x-2 justify-center mt-4">
        <button
          type="button"
          onClick={handlePredict}
          disabled={!userId || submitting}
          className="flex-1 md:flex-none px-4 py-2 bg-white border border-blue-500 text-black rounded-md hover:bg-blue-100 disabled:opacity-50"
        >
          {submitting ? (
            <span className="loader mr-2"></span>
          ) : (
            "🧠 Predict Outcome"
          )}
        </button>

        <button
          type="submit"
          disabled={!userId || !prediction || submitting}
          className="flex-1 md:flex-none px-4 py-2 bg-white border border-green-500 text-black rounded-md hover:bg-green-100 disabled:opacity-50"
        >
          {submitting ? <span className="loader mr-2"></span> : "➕ Add Prop"}
        </button>
      </div>
      {prediction && (
        <div className="mt-4 p-3 bg-green-100 text-green-800 rounded-md text-center">
          🎯 Prediction: <strong>{prediction.recommendation}</strong> <br />
          📈 Confidence Score:{" "}
          <strong>
            {!isNaN(Number(prediction.confidence_score))
              ? Number(prediction.confidence_score).toFixed(4)
              : "—"}
          </strong>
        </div>
      )}
      {successToast && (
        <div className="mt-4 p-3 bg-yellow-100 text-yellow-800 rounded-md text-center">
          {successMessage}
        </div>
      )}
    </form>
  );
};

export default PlayerPropForm;
