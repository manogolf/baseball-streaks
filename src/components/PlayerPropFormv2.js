// src/components/PlayerPropFormv2.js
import React, { useState, useEffect, useRef } from "react";

const BASE_API = "http://localhost:8001";

// simple helpers
async function getApi(path, params = {}) {
  const url = new URL(BASE_API + path);
  for (const [k, v] of Object.entries(params))
    if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}
async function postApi(path, body) {
  const res = await fetch(BASE_API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export default function PlayerPropFormV2() {
  // user-facing fields
  const [playerName, setPlayerName] = useState("");
  const [teamAbbr, setTeamAbbr] = useState("");
  const [gameDate, setGameDate] = useState("");
  const [propType, setPropType] = useState("hits");
  const [overUnder, setOverUnder] = useState("under");
  const [propValue, setPropValue] = useState("0.5");

  // hidden/resolved + flow
  const [playerId, setPlayerId] = useState(""); // keep as string for consistency
  const [commitToken, setCommitToken] = useState(null);
  const [resolving, setResolving] = useState(false);
  const lastReqId = useRef(0); // guards against stale responses
  const [teamTouched, setTeamTouched] = useState(false); // user manually edited team?
  const [lastResolvedPlayerId, setLastResolvedPlayerId] = useState(""); // track which ID we resolved last

  // ui state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prepPreview, setPrepPreview] = useState(null);
  const [prediction, setPrediction] = useState(null);

  useEffect(() => {
    console.info("[Props V2] mounted");
  }, []);

  const PROP_TYPES = [
    "hits",
    "home_runs",
    "rbi",
    "runs_scored",
    "strikeouts_batting",
    "walks",
    "total_bases",
    "singles",
    "doubles",
    "triples",
    "stolen_bases",
    "strikeouts_pitching",
    "outs_recorded",
    "earned_runs",
    "hits_allowed",
    "walks_allowed",
    "hits_runs_rbis",
    "runs_rbis",
  ];

  // --- name → (playerId, teamAbbr) resolver (manual + debounced) ---
  async function resolvePlayerByNameNow() {
    setError("");
    setPlayerId(""); // reset while resolving

    const name = (playerName || "").trim();
    if (name.length < 2) return;

    const params = { name, ...(gameDate ? { date: gameDate } : {}) };

    setResolving(true);
    const reqId = ++lastReqId.current;
    try {
      const r = await getApi("/api/players/resolve", params);

      // ⛔ ignore stale responses
      if (reqId !== lastReqId.current) return;

      // ✅ INSERT THIS LOGIC HERE
      if (r?.player_id) {
        const newId = String(r.player_id);
        if (newId !== lastResolvedPlayerId && !teamTouched) {
          setTeamAbbr(""); // drop stale team from prior player
        }
        setPlayerId(newId);
        setLastResolvedPlayerId(newId);
      } else {
        setPlayerId("");
      }

      // ⚠️ Do NOT set team from resolver:
      // if (!teamAbbr && r?.team_abbr) setTeamAbbr(r.team_abbr);  // ← remove/leave out
    } catch {
      setError("Couldn’t resolve player. Check spelling (or add team).");
    } finally {
      if (reqId === lastReqId.current) setResolving(false);
    }
  }

  // Debounce as the user types
  useEffect(() => {
    const name = (playerName || "").trim();
    if (name.length < 3 || playerId) return;
    const t = setTimeout(resolvePlayerByNameNow, 600);
    return () => clearTimeout(t);
  }, [playerName, gameDate, playerId, teamAbbr]);

  async function handleSubmit(e) {
    e?.preventDefault?.();
    setError("");
    setPrediction(null);
    setCommitToken(null);
    setPrepPreview(null);

    // validation: need either playerId OR (name + team)
    if (!playerId && (!playerName.trim() || !teamAbbr.trim())) {
      return setError("Enter player name + team, or resolve to get an ID.");
    }
    if (!gameDate) return setError("Pick a game date (YYYY-MM-DD).");
    if (!propType) return setError("Pick a prop type.");
    if (propValue === "") return setError("Enter a value.");

    setLoading(true);
    const t0 = performance.now();
    try {
      // 1) prepare (server derives IDs + context)
      const prepPayload = {
        game_date: gameDate,
        prop_type: propType,
        over_under: overUnder,
        prop_value: Number(propValue),
        ...(playerId
          ? { player_id: Number(playerId) }
          : {
              player_name: playerName.trim(),
              team_abbr: teamAbbr.trim().toUpperCase(),
            }),
      };

      console.info("[Props V2] → /api/prepareProp", prepPayload);
      const prepRes = await postApi("/api/prepareProp", prepPayload);
      const features = prepRes.features ?? prepRes;

      if (features.player_id) setPlayerId(String(features.player_id));
      if (features.team) {
        setTeamAbbr(String(features.team).toUpperCase());
        setTeamTouched(false); // came from backend; not a manual edit
      }

      setPrepPreview({
        sample: Object.fromEntries(Object.entries(features).slice(0, 12)),
      });

      // 2) predict (returns commit_token)
      console.info("[Props V2] → /api/predict");
      const pred = await postApi("/api/predict", {
        prop_type: propType,
        features: {
          ...features,
          // ensure the UI dropdown wins for the text abbr
          team: (teamAbbr || features.team || "").toUpperCase(),
        },
      });

      console.info("[Props V2] ← /api/predict", pred);
      setPrediction(pred);
      setCommitToken(pred.commit_token || null);

      const ms = Math.round(performance.now() - t0);
      console.info(`[Props V2] total submit time: ${ms} ms`);
    } catch (err) {
      console.error("[Props V2] submit error:", err);
      setError(err.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveProp() {
    setError("");
    if (!commitToken) return;
    try {
      const res = await postApi("/api/props/add", {
        commit_token: commitToken,
      });
      console.info("[Props V2] saved:", res);
      setPrediction((p) => (p ? { ...p, saved: true } : p));
    } catch (e) {
      setError(e.message || String(e));
    }
  }

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
        {/* Player Name + Resolve */}
        <div className="flex flex-col">
          <span className="text-sm font-medium mb-1">Player Name</span>
          <div className="flex gap-2">
            <input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onBlur={resolvePlayerByNameNow}
              placeholder="e.g., Aaron Judge"
              className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
            />
            <button
              type="button"
              onClick={resolvePlayerByNameNow}
              disabled={!playerName.trim()}
              className="px-3 py-2 bg-white border border-blue-500 text-black rounded-md hover:bg-blue-100 disabled:opacity-50"
            >
              Resolve
            </button>
          </div>
          <div className="min-h-[1.25rem] mt-1 text-xs">
            {resolving ? (
              <span className="text-gray-500">Resolving…</span>
            ) : playerId ? (
              <span className="text-green-700">
                Resolved: #{playerId}
                {teamAbbr ? ` • ${teamAbbr}` : ""}
              </span>
            ) : null}
          </div>
        </div>

        {/* Team (abbr) */}
        <div className="flex flex-col">
          <span className="text-sm font-medium mb-1">Team</span>
          <select
            value={teamAbbr}
            onChange={(e) => setTeamAbbr(e.target.value.toUpperCase())}
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
        </div>

        {/* Prop Type */}
        <div className="flex flex-col">
          <span className="text-sm font-medium mb-1">Prop Type</span>
          <select
            value={propType}
            onChange={(e) => setPropType(e.target.value)}
            required
            className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
          >
            <option value="">Select a prop type</option>
            {PROP_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {/* Prop Value */}
        <div className="flex flex-col">
          <span className="text-sm font-medium mb-1">Prop Value</span>
          <input
            type="number"
            value={propValue}
            onChange={(e) => setPropValue(e.target.value)}
            placeholder="e.g., 0.5"
            className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
            inputMode="decimal"
            step="any"
          />
        </div>

        {/* Over/Under */}
        <div className="flex flex-col">
          <span className="text-sm font-medium mb-1">Over / Under</span>
          <select
            value={overUnder}
            onChange={(e) => setOverUnder(e.target.value)}
            className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
          >
            <option value="">Select Over/Under</option>
            <option value="over">Over</option>
            <option value="under">Under</option>
          </select>
        </div>

        {/* Game Date */}
        <div className="flex flex-col">
          <span className="text-sm font-medium mb-1">Game Date</span>
          <input
            type="date"
            value={gameDate}
            onChange={(e) => setGameDate(e.target.value)}
            className="w-full p-2 bg-gray-50 border border-gray-300 rounded-md"
          />
        </div>
      </div>

      {/* Buttons */}
      <div className="flex space-x-2 justify-center mt-4">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={loading}
          className="flex-1 md:flex-none px-4 py-2 bg-white border border-blue-500 text-black rounded-md hover:bg-blue-100 disabled:opacity-50"
        >
          {loading ? "Working…" : "🧠 Predict Outcome"}
        </button>

        <button
          type="button"
          onClick={handleSaveProp}
          disabled={!commitToken || loading || prediction?.saved}
          className="flex-1 md:flex-none px-4 py-2 bg-white border border-green-500 text-black rounded-md hover:bg-green-100 disabled:opacity-50"
        >
          {prediction?.saved ? "Saved ✓" : "➕ Add Prop"}
        </button>
      </div>

      {/* Prediction summary (theme-friendly) */}
      {prediction && (
        <div className="mt-4 p-3 bg-green-100 text-green-800 rounded-md text-center space-y-1">
          <div>
            🎯 Prediction ready •{" "}
            <strong>
              {typeof prediction.prob === "number"
                ? `${(prediction.prob * 100).toFixed(1)}%`
                : "—"}
            </strong>
          </div>
          {!prediction?.saved ? (
            <div className="text-xs text-green-900/80">
              Not saved yet. Click <em>Add Prop</em> to store it.
            </div>
          ) : (
            <div className="text-xs text-green-900/80">Saved ✓</div>
          )}
        </div>
      )}
    </form>
  );
}
