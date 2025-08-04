//  src/components/PlayerPropForm.js

import { useEffect, useState } from "react";
import Select from "react-select"; // or similar
import { resolvePlayerAndTeam } from "../shared/resolvePlayerAndTeam.js";
import { supabase } from "../utils/supabaseFrontend.js";
import { nowET, todayET } from "../shared/timeUtils.js";
import { useAuth } from "../context/AuthContext.js";
import { getPropTypeOptions } from "../../shared/propUtils.js";
import { enrichGameContext } from "../../shared/enrichGameContext.js";
import { resolveTeamId as resolveTeamIdFallback } from "../../shared/resolveTeamIdFallback.js";
import { getTeamInfoById } from "../../shared/teamNameMap.js";

// const isLocal = window.location.hostname === "localhost";
// const apiUrl = isLocal
//  ? "http://localhost:3001"
//  : "https://baseball-streaks-sq44.onrender.com";

const apiUrl = "https://baseball-streaks-sq44.onrender.com";

function normalizeName(name) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // remove accents
}

/**
 * Resolve and validate player_id.
 * Optionally fetch matching team_id from MT.
 */
export async function resolvePlayerId({ player_id, player_name }) {
  if (!player_id) {
    console.warn("❌ Missing player_id.");
    return null;
  }

  // ✅ Primary: check that player_id exists in player_ids
  const { data: idData, error: idErr } = await supabase
    .from("player_ids")
    .select("player_id")
    .eq("player_id", player_id)
    .maybeSingle();

  if (idData?.player_id) {
    return idData.player_id;
  }

  // 🟡 Fallback: try MT by player_name
  if (player_name) {
    const { data: mtData, error: mtErr } = await supabase
      .from("model_training_props")
      .select("player_id, player_name")
      .order("game_date", { ascending: false })
      .limit(50);

    const normalized = (s) =>
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

    const match = mtData?.find(
      (row) => normalized(row.player_name) === normalized(player_name)
    );

    if (match?.player_id) {
      console.warn("⚠️ Resolved player_id via MT fallback");
      return match.player_id;
    }
  }

  console.warn(`❌ Could not resolve player_id`);
  return null;
}

async function resolveTeamId(player_id) {
  if (!player_id) {
    console.warn("❌ Missing player_id when resolving team_id.");
    return null;
  }

  const { data, error } = await supabase
    .from("model_training_props")
    .select("team_id")
    .eq("player_id", player_id)
    .order("game_date", { ascending: false })
    .limit(1);

  if (error) {
    console.error(
      "❌ Failed to fetch team_id from model_training_props:",
      error.message
    );
    return null;
  }

  const teamId = data?.[0]?.team_id ?? null;

  if (!teamId) {
    console.warn(`⚠️ No team_id found for player_id ${player_id}`);
    return null;
  }

  return teamId;
}

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
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    async function loadContext() {
      const { player_id, player_name, game_date } = formData;

      if (!player_id || !game_date) return;

      // ✅ Step 1: Confirm player_id is valid
      const resolvedPlayerId = await resolvePlayerId({
        player_id,
        player_name, // optional fallback
      });

      if (!resolvedPlayerId) {
        console.warn(`⚠️ Could not resolve player_id`);
        return;
      }

      // ✅ Step 2: Get team_id from MT
      const teamId = await resolveTeamId(resolvedPlayerId);
      console.log("🔍 Attempting to resolve team_id for", resolvedPlayerId);
      const directCheck = await supabase
        .from("player_ids")
        .select("team_id")
        .eq("player_id", resolvedPlayerId)
        .maybeSingle();

      const fallbackCheck = await supabase
        .from("model_training_props")
        .select("team_id")
        .eq("player_id", resolvedPlayerId)
        .order("game_date", { ascending: false })
        .limit(1);

      console.log("🧱 player_ids returned:", directCheck.data);
      console.log("🧱 model_training_props returned:", fallbackCheck.data);

      if (!teamId) {
        console.warn(
          `⚠️ Could not resolve team_id for player ${resolvedPlayerId}`
        );
        return;
      }

      // ✅ Step 3: Enrich context using team_id + game_date
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
  }, [formData.player_id, formData.player_name, formData.game_date]);

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
      // 🧠 Step 1: Merge all available data into one clean object
      const base = {
        player_name: formData.player_name,
        team_abbr: formData.team,
        prop_type: formData.prop_type,
        prop_value: parseFloat(formData.prop_value),
        over_under: formData.over_under?.toLowerCase(),
        game_date: formData.game_date,
        user_id: userId,
      };

      // 🧠 Step 2: Resolve player_id and team_id centrally
      const { player_id, team_id } = await resolvePlayerAndTeam({
        player_name: base.player_name,
        team_abbr: base.team_abbr,
      });

      if (!player_id) {
        setError("❌ Missing player_id — cannot submit prop.");
        setSubmitting(false);
        return;
      }
      if (!team_id) {
        console.warn("⚠️ Could not resolve team_id for player", player_id);
      }

      if (!resolvedGameId) {
        setError("Could not find a game for this team on the selected date.");
        setSubmitting(false);
        return;
      }

      // 🧠 Step 4: Predict
      const predictRes = await fetch(`${apiUrl}/api/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...base,
          player_id,
          team_id,
          game_id: resolvedGameId,
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

      // 🧠 Step 5: Build final submission
      const now = nowET().toISO();

      const finalSubmission = {
        ...base,
        player_id,
        team_id,
        game_id: resolvedGameId,
        status: "pending",
        created_at: now,
        prediction_timestamp: now,
        prop_source: "user_added",
        predicted_outcome: predictJson.predicted_outcome ?? null,
        confidence_score: predictJson.confidence_score ?? null,
        is_home: predictJson?.is_home ?? null,
        opponent: predictJson?.opponent ?? null,
        opponent_encoded: predictJson?.opponent_encoded ?? null,
        game_time: predictJson?.game_time ?? null,
        game_day_of_week: predictJson?.game_day_of_week ?? null,
        time_of_day_bucket: predictJson?.time_of_day_bucket ?? null,
        starting_pitcher_id: predictJson?.starting_pitcher_id ?? null,
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
