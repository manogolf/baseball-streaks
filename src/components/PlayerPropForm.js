import { useEffect, useState } from "react";
import { supabase } from "../utils/supabaseUtils.js";
import { nowET, todayET } from "../utils/timeUtils.js";
import { useAuth } from "../context/AuthContext.js";
import { buildFeatureVector } from "../utils/buildFeatureVector.js";
import { requiredFeatures } from "../config/predictionSchema.js";
import { normalizeFeatureKeys } from "../utils/normalizeFeatureKeys.js";
import { preparePropSubmission } from "../utils/playerUtils.js";
import {
  propExtractors,
  getPropDisplayLabel,
  normalizePropType,
} from "../utils/propUtils.js";

const apiUrl = `${
  process.env.REACT_APP_API_URL || "http://localhost:8000"
}/predict`;

const PlayerPropForm = ({ onPropAdded }) => {
  const today = todayET();
  const auth = useAuth();
  const user = auth?.user || { id: "test-user" };

  const [formData, setFormData] = useState({
    player_name: "",
    team: "",
    prop_type: "",
    prop_value: "",
    over_under: "over",
    game_date: todayET(),
  });

  const [propTypes, setPropTypes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [prediction, setPrediction] = useState(null);
  const [successToast, setSuccessToast] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const propTypeOptions = Object.keys(propExtractors)
    .map((_, i, arr) => {
      const normalizedKey = normalizePropType(arr[i]);
      return {
        value: normalizedKey,
        label: getPropDisplayLabel(normalizedKey),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label)); // ✅ Alphabetical sort by label

  const successMessages = [
    "🎯 Prediction ready — make your move!",
    "🧠 Got a prediction — trust your gut!",
    "🚀 Data's in. Your turn to shine!",
    "📈 Looks promising! Place your prop wisely.",
    "🔥 Prediction locked — time to go big!",
  ];

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

  const handlePredict = async () => {
    setError("");
    setPrediction(null);
    setSubmitting(true);

    const { player_name, team, prop_type, prop_value, game_date, over_under } =
      formData;

    if (
      !player_name ||
      !team ||
      !prop_type ||
      !prop_value ||
      !game_date ||
      !over_under
    ) {
      setError("All fields are required for prediction.");
      setSubmitting(false);
      return;
    }

    try {
      const apiUrl = `${
        process.env.REACT_APP_API_URL || "http://localhost:8001"
      }/predict`;

      const preparedData = await preparePropSubmission({
        player_name,
        team,
        prop_type,
        prop_value,
        over_under,
        game_date,
      });

      const features = await buildFeatureVector({
        player_name,
        team,
        prop_type,
        game_date,
      });

      console.log("📊 Feature Vector Result:", features);

      if (!features || !features.player_id) {
        setError("Could not resolve player ID or generate features.");
        setSubmitting(false);
        return;
      }

      const normalized = normalizeFeatureKeys(features);
      const fullFeatures = { ...requiredFeatures, ...normalized };

      const predictionPayload = {
        player_id: String(preparedData.player_id), // Force string type
        prop_type: preparedData.prop_type,
        prop_value: parseFloat(preparedData.prop_value),
        over_under: preparedData.over_under.toLowerCase(),
        ...fullFeatures,
      };

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(predictionPayload),
      });

      if (!response.ok) throw new Error("Prediction API returned error");

      const result = await response.json();

      console.log("📬 Received prediction:", result); // ✅ this is your actual prediction

      setPrediction(result);

      const randomIndex = Math.floor(Math.random() * successMessages.length);
      setSuccessMessage(successMessages[randomIndex]);
      setSuccessToast(true);
      setTimeout(() => setSuccessToast(false), 4000);
    } catch (err) {
      console.error("❌ Prediction Error:", err);
      setError("Prediction failed or timed out.");
      setTimeout(() => setError(""), 4000);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      // 👉 Step 1: Generate prediction
      const predictionPayload = await buildFeatureVector({
        player_name: formData.player_name,
        team: formData.team,
        prop_type: formData.prop_type,
        prop_value: formData.prop_value,
        over_under: formData.over_under,
        game_date: formData.game_date,
      });

      console.log("📊 Feature Vector Result:", predictionPayload);

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(predictionPayload),
      });

      if (!response.ok) throw new Error("Prediction API returned error");

      const result = await response.json();
      console.log("📬 Received prediction:", result);

      // Optional: setPrediction(result); — only needed for UI use

      // 👉 Step 2: Resolve Game ID early to catch errors
        let resolvedGameId;
        try {
          resolvedGameId = await getGamePkForTeamOnDate(team, game_date);
          if (!resolvedGameId) {
            throw new Error(`No game found for ${team} on ${game_date}`);
          }
        } catch (err) {
          alert(`⚠️ Could not find a game for ${team} on ${game_date}. Please check the date or team abbreviation.`);
          setSubmitting(false);
          return;
        }
        
        // 👉 Step 3: Prepare full prop submission data with injected game_id
        const preparedData = await preparePropSubmission({
          ...formData,
          game_id: resolvedGameId,
        });
        
        const { player_id } = preparedData;
        const now = nowET().toISO();
        
        const payload = {
          player_name: preparedData.player_name || formData.player_name,
          team: preparedData.team || formData.team,
          prop_type: preparedData.prop_type,
          prop_value: parseFloat(preparedData.prop_value),
          game_date: preparedData.game_date || formData.game_date,
          game_id: resolvedGameId,
          player_id,
          status: "pending",
          created_at: now,
          predicted_outcome: result?.predicted_outcome ?? null,
          confidence_score: result?.confidence_score ?? null,
          prediction_timestamp: result ? now : null,
          over_under: preparedData.over_under.toLowerCase(),
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
            "ATL",
            "AZ",
            "BAL",
            "BOS",
            "CHC",
            "CHW",
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
            "OAK",
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
          disabled={submitting}
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
          disabled={!prediction || submitting}
          className="flex-1 md:flex-none px-4 py-2 bg-white border border-green-500 text-black rounded-md hover:bg-green-100 disabled:opacity-50"
        >
          {submitting ? <span className="loader mr-2"></span> : "➕ Add Prop"}
        </button>
      </div>
      {prediction && (
        <div className="mt-4 p-3 bg-green-100 text-green-800 rounded-md text-center">
          📈 Prediction: <strong>{prediction.predicted_outcome}</strong> <br />
          🎯 Confidence:{" "}
          <strong>{(prediction.confidence_score * 100).toFixed(1)}%</strong>
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
