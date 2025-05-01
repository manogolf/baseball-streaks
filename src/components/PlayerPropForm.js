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

    const { prop_type, prop_value } = formData;
    if (!prop_type || !prop_value) {
      setError("Prop type and value are required to predict.");
      setSubmitting(false);
      return;
    }

    try {
      const apiUrl = `${process.env.REACT_APP_API_URL}/predict`;
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
          disabled={submitting}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
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
    </form>
  );
};

export default PlayerPropForm;
