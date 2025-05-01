import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { getGamePkForTeamOnDate } from "../utils/fetchGameID.js";
import { DateTime } from "luxon";
import { useAuth } from "../context/AuthContext.jsx";

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
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [prediction, setPrediction] = useState(null);
  const [errorFade, setErrorFade] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [predictionAttempted, setPredictionAttempted] = useState(false);
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
      if (error) {
        console.error("Error fetching prop types:", error.message);
      } else {
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

    const { prop_type, prop_value } = formData;

    if (!prop_type || !prop_value) {
      setError("Prop type and value are required to predict.");
      setSubmitting(false);
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const apiUrl = `${process.env.REACT_APP_API_URL}/predict`;
      console.log("🌐 Predicting using URL:", apiUrl);

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prop_type,
          prop_value: parseFloat(prop_value),
          rolling_result_avg_7: 1.3,
          hit_streak: 3,
          win_streak: 2,
          is_home: 1,
          opponent_avg_win_rate: 0.53,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) throw new Error("Prediction API returned error");

      const result = await response.json();
      console.log("🔮 Prediction result:", result);

      setPrediction({
        prediction: result.prediction,
        confidence: result.probability,
      });

      // 🎯 New: Random witty success message
      const randomIndex = Math.floor(Math.random() * successMessages.length);
      setSuccessMessage(successMessages[randomIndex]);

      setSuccessToast(true);
      setTimeout(() => setSuccessToast(false), 4000);
    } catch (err) {
      console.warn("🚨 Prediction fetch failed:", err);
      setError("Prediction failed or timed out.");
      setErrorFade(false);
      setTimeout(() => setErrorFade(true), 3000);
      setTimeout(() => setError(""), 3500);

      setShowWarning(true);
      setTimeout(() => setShowWarning(false), 4000);
    } finally {
      setPredictionAttempted(true);
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSuccess(false);
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
      setErrorFade(false);
      setTimeout(() => setErrorFade(true), 3000);
      setTimeout(() => setError(""), 3500);
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
      over_under,
      game_date,
      game_id,
      status: "pending",
      created_et: nowET,
    };

    const { error: insertError } = await supabase
      .from("player_props")
      .insert([payload]);

    if (insertError) {
      console.error("Error inserting player prop:", insertError.message);
      setError("Failed to add prop.");
      setErrorFade(false);
      setTimeout(() => setErrorFade(true), 3000);
      setTimeout(() => setError(""), 3500);
    } else {
      setSuccess(true);
      setFormData({
        player_name: "",
        team: "",
        prop_type: "",
        prop_value: "",
        over_under: "",
        game_date: todayET,
      });
      setPrediction(null);

      await fetchProps(); // 🛠 Only re-fetch if insertion was successful
    }

    setSubmitting(false);
  };

  return (
    <div className="bg-white p-4 rounded-xl shadow-sm mt-6">
      <h2 className="text-lg font-semibold mb-4 text-left">
        Add Player prop{" "}
        <span className="text-indigo-900 text-sm">• Powered by P³</span>
      </h2>
      {user ? (
        <>
          <form onSubmit={handleSubmit} className="grid gap-3 md:grid-cols-2">
            <input
              type="text"
              name="player_name"
              placeholder="Player Name"
              value={formData.player_name}
              onChange={handleChange}
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
              type="number"
              name="prop_value"
              placeholder="Value (e.g., 1.5)"
              value={formData.prop_value}
              onChange={handleChange}
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
              type="date"
              name="game_date"
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
                className="bg-purple-900 text-white px-4 py-2 rounded hover:bg-purple-900"
              >
                Predict
              </button>

              <button
                type="submit"
                disabled={!predictionAttempted || submitting}
                className={`${
                  predictionAttempted
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-gray-300 cursor-not-allowed"
                } text-white px-4 py-2 rounded`}
              >
                Add Prop
              </button>
            </div>

            {success && <div className="text-green-600 mt-2">Prop added!</div>}
            {error && (
              <div
                className={`text-red-600 mt-2 transition-opacity duration-500 ${
                  errorFade ? "fade-out" : ""
                }`}
              >
                {error}
              </div>
            )}
          </form>

          {prediction && (
            <div className="mt-6 flex items-center gap-4 p-4 border rounded-xl bg-gray-50 shadow-sm">
              <div className="w-6 h-6 rounded-full animate-pulse bg-gradient-to-br from-purple-400 to-indigo-500 shadow-md" />
              <div>
                <p>
                  Prediction: <strong>{prediction.prediction}</strong>
                </p>
                <p>
                  Confidence:{" "}
                  <strong>{(prediction.confidence * 100).toFixed(1)}%</strong>
                </p>
              </div>
            </div>
          )}

          <div className="text-sm text-gray-600 mt-4">
            <p>
              📍 Your local time:{" "}
              <strong>
                {DateTime.now().toLocaleString(DateTime.DATETIME_SHORT)}
              </strong>
            </p>
            <p>
              🕰 MLB time (ET):{" "}
              <strong>
                {DateTime.now()
                  .setZone("America/New_York")
                  .toLocaleString(DateTime.DATETIME_SHORT)}
              </strong>
            </p>
          </div>
          {successToast && (
            <div className="fixed bottom-4 right-4 bg-green-100 text-green-800 px-4 py-2 rounded shadow-lg animate-fade-in-out transition-opacity duration-300 z-50">
              {successMessage}
            </div>
          )}
          {showWarning && (
            <div className="fixed bottom-4 right-4 bg-yellow-100 text-yellow-800 px-4 py-2 rounded shadow-lg animate-fade-in-out transition-opacity duration-300 z-50">
              ⚠️ Prediction failed — you can still add the prop.
            </div>
          )}
        </>
      ) : (
        <div className="text-center text-gray-500 mt-6">
          🔒 Please log in to predict and add props.
        </div>
      )}
    </div>
  );
};

export default PlayerPropForm;
