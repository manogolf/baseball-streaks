import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { getEasternDateString } from "../utils/getEasternDateString.js";

const PlayerPropsTable = () => {
  const [props, setProps] = useState([]);
  const [recentProps, setRecentProps] = useState([]);
  const [sortConfig, setSortConfig] = useState({
    key: "game_date",
    direction: "asc",
  });

  const statusColor = {
    win: "bg-green-100 text-green-700",
    loss: "bg-red-100 text-red-700",
    live: "bg-yellow-100 text-yellow-800 animate-pulse",
    pending: "bg-gray-100 text-gray-600",
  };

  useEffect(() => {
    const fetchProps = async () => {
      const today = getEasternDateString();
      const { data, error } = await supabase
        .from("player_props")
        .select("*")
        .eq("game_date", today)
        .neq("status", "expired");

      if (!error) {
        setProps(data);
        console.log("📊 Fetched props:", data);
      } else {
        console.error("Error fetching props:", error.message);
      }
    };

    fetchProps(); // Don't forget to actually call it too!

    // 🧠 Setup Realtime subscription
    const subscription = supabase
      .channel("public:player_props") // listen on the table
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "player_props" },
        (payload) => {
          console.log("🔔 New prop inserted!", payload.new);
          setProps((prev) => [payload.new, ...prev]);
          setRecentProps((prev) => [...prev, payload.new.id]); // track new prop ID

          // 🕒 Remove highlight after 5 seconds
          setTimeout(() => {
            setRecentProps((prev) =>
              prev.filter((id) => id !== payload.new.id)
            );
          }, 5000);
        }
      )

      .subscribe();

    // ✅ Cleanup when component unmounts
    return () => {
      supabase.removeChannel(subscription);
    };
  }, []); // Don't forget the dependency array (empty!)

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
        <tbody className="bg-red-200">
          {sortedProps.map((p) => (
            <tr
              key={p.id}
              className={`border-t transition-all duration-500 hover:bg-gray-50 ${
                recentProps.includes(p.id) ? "bg-yellow-100" : ""
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
                    statusColor[p.outcome] ||
                    (p.status === "resolved"
                      ? "bg-gray-200 text-gray-600"
                      : statusColor.pending)
                  }`}
                >
                  {(p.outcome || p.status || "pending")
                    .charAt(0)
                    .toUpperCase() +
                    (p.outcome || p.status || "pending").slice(1)}
                </span>
              </td>
              <td className="px-3 py-2">{p.over_under}</td>
              <td className="px-3 py-2">{p.game_date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default PlayerPropsTable;
