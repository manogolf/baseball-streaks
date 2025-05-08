import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { nowET, todayET, currentTimeET } from "../utils/timeUtils.js";

const statusColor = {
  win: "bg-green-100 text-green-700",
  loss: "bg-red-100 text-red-700",
  push: "bg-blue-100 text-blue-700",
  resolved: "bg-gray-200 text-gray-600",
  live: "bg-yellow-100 text-yellow-800 animate-pulse",
  pending: "bg-gray-100 text-gray-600",
};

const PlayerPropsTable = () => {
  const [props, setProps] = useState([]);
  const [recentProps, setRecentProps] = useState([]);
  const [sortConfig, setSortConfig] = useState({
    key: "game_date",
    direction: "asc",
  });

  useEffect(() => {
    const fetchProps = async () => {
      const today = todayET();
      // console.log("📆 Fetching props for:", todayET);

      const { data, error } = await supabase
        .from("player_props")
        .select("*")
        .eq("game_date", todayET)
        .neq("status", "expired");

      if (error) {
        console.error("❌ Error fetching props:", error.message);
        return;
      }

      console.log(
        "📦 Props returned:",
        data.map((p) => ({
          id: p.id,
          player: p.player_name,
          outcome: p.outcome,
          status: p.status,
        }))
      );

      setProps(data);
    };

    fetchProps();

    const subscription = supabase
      .channel("public:player_props")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "player_props" },
        (payload) => {
          console.log("🔔 New prop inserted!", payload.new);
          setProps((prev) => [payload.new, ...prev]);
          setRecentProps((prev) => [...prev, payload.new.id]);

          setTimeout(() => {
            setRecentProps((prev) =>
              prev.filter((id) => id !== payload.new.id)
            );
          }, 5000);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, []);

  const sortedProps = [...props].sort((a, b) => {
    const aVal = a[sortConfig.key];
    const bVal = b[sortConfig.key];
    if (aVal < bVal) return sortConfig.direction === "asc" ? -1 : 1;
    if (aVal > bVal) return sortConfig.direction === "asc" ? 1 : -1;
    return 0;
  });

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
    }));
  };

  const getArrow = (key) =>
    sortConfig.key === key
      ? sortConfig.direction === "asc"
        ? " ↑"
        : " ↓"
      : "";

  return (
    <div className="bg-white p-4 rounded-xl shadow-md overflow-x-auto">
      <h2 className="text-lg font-semibold mb-4">Today’s Player Props</h2>
      <table className="min-w-full text-sm text-gray-800">
        <thead className="bg-gray-100">
          <tr>
            <th
              className="px-3 py-2 text-left cursor-pointer"
              onClick={() => handleSort("player_name")}
            >
              Player{getArrow("player_name")}
            </th>
            <th
              className="px-3 py-2 text-left cursor-pointer"
              onClick={() => handleSort("team")}
            >
              Team{getArrow("team")}
            </th>
            <th
              className="px-3 py-2 text-left cursor-pointer"
              onClick={() => handleSort("prop_type")}
            >
              Prop{getArrow("prop_type")}
            </th>
            <th
              className="px-3 py-2 text-left cursor-pointer"
              onClick={() => handleSort("prop_value")}
            >
              Value{getArrow("prop_value")}
            </th>
            <th className="px-3 py-2 text-left">Status</th>
            <th
              className="px-3 py-2 text-left cursor-pointer"
              onClick={() => handleSort("over_under")}
            >
              O/U{getArrow("over_under")}
            </th>
            <th
              className="px-3 py-2 text-left cursor-pointer"
              onClick={() => handleSort("game_date")}
            >
              Game Date{getArrow("game_date")}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedProps.map((p) => {
            const statusKey = (
              p.outcome ??
              p.status ??
              "pending"
            ).toLowerCase();
            const label =
              statusKey.charAt(0).toUpperCase() + statusKey.slice(1);

            return (
              <tr
                key={p.id}
                className={`border-t transition-all duration-500 hover:bg-gray-50 ${
                  recentProps.includes(p.id) ? "bg-blue-100" : ""
                }`}
              >
                <td className="px-3 py-2">
                  {p.player_name}
                  {p.position && (
                    <span className="ml-1 text-xs text-gray-500">
                      ({p.position})
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{p.team}</td>
                <td className="px-3 py-2">{p.prop_type}</td>
                <td className="px-3 py-2">{p.prop_value}</td>
                <td className="px-3 py-2">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-semibold ${
                      statusColor[statusKey] || statusColor.pending
                    }`}
                  >
                    {label}
                  </span>
                </td>
                <td className="px-3 py-2">{p.over_under}</td>
                <td className="px-3 py-2">{p.game_date}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default PlayerPropsTable;
