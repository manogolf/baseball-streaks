import React, { useState } from "react";
import PropTracker from "../components/PropTracker.js"; // 📅 Calendar
import PlayerPropsTable from "../components/PlayerPropsTable.js"; // 📊 Table
import PlayerPropForm from "../components/PlayerPropForm.js"; // 📝 Form
import { useAuth } from "../context/AuthContext.js";

export default function PropsDashboard() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(null); // 🗓 controlled from calendar

  return (
    <div className="max-w-5xl mx-auto space-y-6 px-4 pb-10">
      <div className="bg-white p-4 rounded-xl shadow">
        {user ? (
          <PlayerPropForm />
        ) : (
          <div className="text-center text-gray-500">
            🔒 You must{" "}
            <a href="/login" className="underline text-blue-600">
              log in
            </a>{" "}
            to add props.
          </div>
        )}
      </div>

      <div className="bg-white p-4 rounded-xl shadow">
        <PlayerPropsTable selectedDate={selectedDate} />
      </div>

      <div className="bg-white p-4 rounded-xl shadow">
        <PropTracker
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
        />
      </div>
    </div>
  );
}
