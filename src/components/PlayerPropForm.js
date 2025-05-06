import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { getGamePkForTeamOnDate } from "../utils/fetchGameID.js";
import { DateTime } from "luxon";
import { useAuth } from "../context/AuthContext.jsx";
import { buildFeatureVector } from "../utils/buildFeatureVector.js";

const teams = [
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
];

const handlePredict = async () => {
  setError("");
  setPrediction(null);
  setSubmitting(true);

  const { player_name, team, prop_type, prop_value, game_date } = formData;

  try {
    const features = await buildFeatureVector(
      player_name,
      team,
      prop_type,
      game_date
    );
    if (!features) throw new Error("Failed to build feature vector");

    const apiUrl = `${process.env.REACT_APP_API_URL}/predict`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prop_type,
        prop_value: parseFloat(prop_value),
        ...features,
      }),
    });

    if (!response.ok) throw new Error("Prediction API returned error");
    console.log("📩 Prediction API response:", prediction);
    console.log("🎯 predicted_outcome:", prediction.predicted_outcome);
    console.log("📈 confidence_score:", prediction.confidence_score);

    // ✅ THIS WAS MISSING:
    const prediction = await response.json();

    const result = await response.json();
    setPrediction({
      prediction: result.prediction,
      confidence: result.probability,
    });

    const randomIndex = Math.floor(Math.random() * successMessages.length);
    setSuccessMessage(successMessages[randomIndex]);
    setSuccessToast(true);
    setTimeout(() => setSuccessToast(false), 4000);
  } catch (err) {
    setError("Prediction failed or timed out.");
    setTimeout(() => setError(""), 4000);
  } finally {
    setSubmitting(false);
  }
};

const PlayerPropForm = () => {
  const todayET = DateTime.now().setZone("America/New_York").toISODate();
  const auth = useAuth();
  const user = auth?.user || { id: "test-user" };

  const [formData, setFormData] = useState({
    player_name: "",
    team: "",
    prop_type: "",
    prop_value: "",
    over_under: "",
    game_date: todayET,
  });

  const [propTypes, setPropTypes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [prediction, setPrediction] = useState(null);
  const [successToast, setSuccessToast] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

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
      if (!error && data) {
        setPropTypes(data.map((item) => item.name));
      }
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

    const { player_name, team, prop_type, prop_value, game_date } = formData;

    if (!player_name || !team || !prop_type || !prop_value || !game_date) {
      setError("All fields are required for prediction.");
      setSubmitting(false);
      return;
    }

    try {
      const apiUrl = `${
        process.env.REACT_APP_API_URL || "http://localhost:8001"
      }/predict`;

      const features = await buildFeatureVector({
        player_name,
        team,
        prop_type,
        game_date,
      });

      if (!features) {
        setError("Could not generate features for prediction.");
        setSubmitting(false);
        return;
      }

      console.log("📤 Sending prediction request to:", apiUrl);

      // 🔍 Diagnostic logs
      console.log("🔎 Raw formData.over_under:", formData.over_under);
      console.log("🔽 Lowercased value:", formData.over_under.toLowerCase());

      console.log("🧠 Full prediction payload:", {
        prop_type,
        prop_value: parseFloat(prop_value),
        over_under: formData.over_under.toLowerCase(), // ✅ log what you’re actually sending
        ...features,
      });

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prop_type,
          prop_value: parseFloat(prop_value),
          over_under: formData.over_under.toLowerCase(), // ✅ final payload
          ...features,
        }),
      });

      if (!response.ok) throw new Error("Prediction API returned error");

      const result = await response.json();
      setPrediction({
        prediction: result.prediction,
        confidence: result.probability,
      });

      const randomIndex = Math.floor(Math.random() * successMessages.length);
      setSuccessMessage(successMessages[randomIndex]);
      setSuccessToast(true);
      setTimeout(() => setSuccessToast(false), 4000);
    } catch (err) {
      console.error("❌ Prediction error:", err);
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

    const { player_name, team, prop_type, prop_value, over_under, game_date } =
      formData;

    if (
      !player_name ||
      !team ||
      !prop_type ||
      !prop_value ||
      !over_under ||
      !game_date
    ) {
      setError("All fields are required.");
      setSubmitting(false);
      return;
    }

    let game_id = null;
    try {
      game_id = await getGamePkForTeamOnDate(team, game_date);
    } catch (err) {
      console.error("Failed to fetch game ID:", err);
    }

    const nowET = DateTime.now().setZone("America/New_York").toISO();

    const payload = {
      player_name,
      team,
      prop_type,
      prop_value: parseFloat(prop_value),
      game_date,
      game_id,
      status: "pending",
      created_et: nowET,
      predicted_outcome: prediction?.prediction || null,
      confidence_score: prediction?.confidence || null,
      prediction_timestamp: prediction ? nowET : null,
      over_under: formData.over_under,
    };

    const { error: insertError } = await supabase
      .from("player_props")
      .insert([payload]);

    if (insertError) {
      console.error("Insert error:", insertError);
      setError("Failed to add prop.");
    } else {
      setFormData({
        player_name: "",
        team: "",
        prop_type: "",
        prop_value: "",
        over_under: "",
        game_date: todayET,
      });

      setPrediction(null);
      setSuccessMessage("✅ Prop added successfully. Good luck!");
      setSuccessToast(true);
      setTimeout(() => setSuccessToast(false), 4000);
    }

    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 md:grid-cols-2">
      <input
        name="player_name"
        value={formData.player_name}
        onChange={handleChange}
        placeholder="Player Name"
        className="border p-2 rounded"
        required
      />
      <select
        name="team"
        value={formData.team}
        onChange={handleChange}
        className="border p-2 rounded"
        required
      >
        <option value="">Select Team</option>
        {teams.map((team) => (
          <option key={team} value={team}>
            {team}
          </option>
        ))}
      </select>
      <select
        name="prop_type"
        value={formData.prop_type}
        onChange={handleChange}
        className="border p-2 rounded"
        required
      >
        <option value="">Select Prop Type</option>
        {propTypes.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <input
        name="prop_value"
        value={formData.prop_value}
        onChange={handleChange}
        placeholder="Value"
        type="number"
        className="border p-2 rounded"
        required
      />
      <select
        name="over_under"
        value={formData.over_under}
        onChange={handleChange}
        className="border p-2 rounded"
        required
      >
        <option value="">Select Over/Under</option>
        <option value="Over">Over</option>
        <option value="Under">Under</option>
      </select>
      <input
        name="game_date"
        type="date"
        value={formData.game_date}
        onChange={handleChange}
        className="border p-2 rounded"
        required
      />

      <div className="flex gap-4 mt-2">
        <button
          type="button"
          onClick={handlePredict}
          disabled={submitting}
          className="bg-purple-900 text-white px-4 py-2 rounded hover:bg-purple-800"
        >
          Predict
        </button>
        <button
          type="submit"
          disabled={submitting || !prediction}
          className={`px-4 py-2 rounded text-white ${
            submitting || !prediction
              ? "bg-blue-300 cursor-not-allowed"
              : "bg-blue-600 hover:bg-blue-700"
          }`}
        >
          Add Prop
        </button>
      </div>

      {prediction && (
        <div className="col-span-2 mt-4 p-4 border rounded bg-gray-50">
          <p>
            <strong>Prediction:</strong> {prediction.prediction}
          </p>
          <p>
            <strong>Confidence:</strong>{" "}
            {(prediction.confidence * 100).toFixed(1)}%
          </p>
        </div>
      )}

      {error && <div className="col-span-2 text-red-600">{error}</div>}
      {successToast && (
        <div className="fixed bottom-4 right-4 bg-green-100 text-green-800 px-4 py-2 rounded shadow-lg z-50">
          {successMessage}
        </div>
      )}

      {!prediction && (
        <div className="col-span-2 text-yellow-600 text-sm mt-1">
          ⚠️ You must run a prediction before submitting a prop.
        </div>
      )}
    </form>
  );
};

export default PlayerPropForm;
