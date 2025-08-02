//  src/components/PlayerPropForm.js

import { useEffect, useState } from "react";
import { supabase } from "../utils/supabaseFrontend.js";
import { nowET, todayET } from "../shared/timeUtils.js";
import { useAuth } from "../context/AuthContext.js";
import { getPropTypeOptions } from "../../shared/propUtils.js";
import { enrichGameContext } from "../../shared/enrichGameContext.js";

// const isLocal = window.location.hostname === "localhost";
// const apiUrl = isLocal
//  ? "http://localhost:3001"
//  : "https://baseball-streaks-sq44.onrender.com";

const apiUrl = "https://baseball-streaks-sq44.onrender.com";

const PlayerPropForm = ({ onPropAdded }) => {
  const today = todayET();
  const auth = useAuth();

  // 🆔 Logged‑in Supabase user UUID
  const [userId, setUserId] = useState(null);

  // 🌱 Local form state
  const [formData, setFormData] = useState({
    player_name: "",
    player_id: null,
    team: "",
    prop_type: "",
    prop_value: 0.5,
    over_under: "under",
    game_date: todayET(),
  });

  const [context, setContext] = useState(null);

  useEffect(() => {
    async function loadContext() {
      if (!formData.team || !formData.game_date) return;
      try {
        const ctx = await enrichGameContext({
          team: formData.team,
          gameDate: formData.game_date,
        });

        const enrichedContext = {
          ...ctx,
          ...(formData.player_id && { player_id: formData.player_id }),
        };

        setContext(enrichedContext);
      } catch (err) {
        console.error("❌ Failed to enrich game context:", err);
      }
    }

    loadContext();
  }, [formData.team, formData.game_date, formData.player_id]);

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
      const enrichedProp = {
        playerName: formData.player_name,
        player_id: context.player_id,
        teamAbbr: formData.team,
        propType: formData.prop_type,
        line: formData.prop_value,
        overUnder: formData.over_under,
        gameDate: formData.game_date,
        ...context,
        user_id: userId, // ✅ attach userId here
      };

      console.log("📤 Sending to /api/prepareProp:", enrichedProp);
      console.log("🔗 Sending to API URL:", apiUrl);

      const res = await fetch(`${apiUrl}/api/prepareProp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enrichedProp),
      });

      const preparedData = await res.json();

      if (!res.ok || !preparedData?.player_id) {
        setError("Failed to prepare prop for prediction.");
        setSubmitting(false);
        return;
      }

      // 🎯 Make prediction
      const predictRes = await fetch(`${apiUrl}/api/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preparedData),
      });

      const predictJson = await predictRes.json();

      if (!predictRes.ok || !predictJson || predictJson.error) {
        throw new Error(
          predictJson?.error || "Prediction request failed. Try again."
        );
      }

      // 🔐 Preserve prepared prop for submission
      setPrediction({
        ...predictJson,
        preparedProp: preparedData,
      });
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

    if (
      !prediction ||
      prediction.predicted_outcome == null ||
      prediction.confidence_score == null
    ) {
      setError("Please make a prediction before submitting.");
      setSubmitting(false);
      return;
    }

    try {
      // 👉 Step 1: Resolve MLB game ID
      const gamePkRes = await fetch(`${apiUrl}/api/getGamePk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          team: formData.team,
          game_date: formData.game_date,
        }),
      });

      const { gamePk: resolvedGameId } = await gamePkRes.json();

      if (!resolvedGameId) {
        setError("Could not find a game for this team on the selected date.");
        setSubmitting(false);
        return;
      }

      // ✅ Reuse previous prepared data from prediction
      if (!prediction.preparedProp?.player_id) {
        setError("Missing prepared prop. Please re-run prediction.");
        setSubmitting(false);
        return;
      }

      const prepared = prediction.preparedProp;
      const now = nowET().toISO();

      // 👉 Step 3: Build full payload
      const payload = {
        player_name: prepared.player_name || formData.player_name,
        team: prepared.team || formData.team,
        prop_type: prepared.prop_type,
        prop_value: parseFloat(prepared.prop_value),
        game_date: prepared.game_date || formData.game_date,
        game_id: resolvedGameId,
        player_id: prepared.player_id,
        status: "pending",
        created_at: now,
        predicted_outcome: prediction.predicted_outcome,
        confidence_score: prediction.confidence_score,
        prediction_timestamp: now,
        over_under: prepared.over_under.toLowerCase(),
        user_id: userId,
        prop_source: "user_added",
        // ✅ Game context fields already exist in `prepared`
        is_home: prepared.is_home,
        opponent: prepared.opponent,
        opponent_encoded: prepared.opponent_encoded,
        game_time: prepared.game_time,
        game_day_of_week: prepared.game_day_of_week,
        time_of_day_bucket: prepared.time_of_day_bucket,
        starting_pitcher_id: prepared.starting_pitcher_id,
      };

      console.log("📦 Final payload:", payload);

      // 👉 Step 4: Insert into Supabase
      const { error: insertError } = await supabase
        .from("player_props")
        .insert([payload]);

      if (insertError) {
        if (insertError.code === "23505") {
          setError("You've already submitted this prop.");
        } else {
          setError("Failed to save prop.");
        }
        console.error("❌ Supabase insert error:", insertError.message);
        setTimeout(() => setError(""), 4000);
        return;
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
        <input
          type="text"
          name="player_name"
          value={formData.player_name}
          onChange={handleChange}
          placeholder="Player Name"
          className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
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
          📈 Prediction: <strong>{prediction.predicted_outcome}</strong> <br />
          🎯 Confidence:{" "}
          <strong>{(prediction.confidence_score * 100).toFixed(2)}%</strong>
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
