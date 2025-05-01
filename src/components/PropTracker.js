import { useEffect, useState } from "react";
import { format, isValid } from "date-fns";
import { supabase } from "../lib/supabaseClient.js";
import Calendar from "./ui/calendar.jsx";

export default function PropTracker() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [allProps, setAllProps] = useState([]);
  const [filteredProps, setFilteredProps] = useState([]);

  useEffect(() => {
    const fetchProps = async () => {
      const { data, error } = await supabase.from("player_props").select("*");
      if (error) console.error("Error fetching props:", error);
      else setAllProps(data);
    };
    fetchProps();
  }, []);

  useEffect(() => {
    const selectedDateObj =
      typeof selectedDate === "string"
        ? new Date(selectedDate + "T00:00:00")
        : selectedDate;

    if (!isValid(selectedDateObj)) {
      console.warn("Invalid selected date:", selectedDate);
      return;
    }

    const selectedDateString = format(selectedDateObj, "yyyy-MM-dd");
    const filtered = allProps.filter(
      (prop) => prop.game_date === selectedDateString
    );
    setFilteredProps(filtered);
  }, [selectedDate, allProps]);

  const selectedDateObj =
    typeof selectedDate === "string"
      ? new Date(selectedDate + "T00:00:00")
      : selectedDate;

  const formattedDate = isValid(selectedDateObj)
    ? format(selectedDateObj, "PPP")
    : "Invalid Date";

  const renderPropsTable = (props) => (
    <div className="bg-white shadow-md rounded-lg overflow-hidden border">
      <table className="w-full text-sm text-left">
        <thead className="bg-gray-100">
          <tr>
            <th className="px-4 py-2">Player</th>
            <th className="px-4 py-2">Team</th>
            <th className="px-4 py-2">Prop</th>
            <th className="px-4 py-2">Value</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">O/U</th>
          </tr>
        </thead>
        <tbody>
          {props.length > 0 ? (
            props.map((prop, index) => (
              <tr key={index} className="border-t">
                <td className="px-4 py-2">
                  {prop.player_name}
                  {prop.position && (
                    <span className="ml-1 text-xs text-gray-500">
                      ({prop.position})
                    </span>
                  )}
                </td>

                <td className="px-4 py-2">{prop.team}</td>
                <td className="px-4 py-2">{prop.prop_type}</td>
                <td className="px-4 py-2">{prop.prop_value}</td>
                <td className="px-4 py-2">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-semibold
      ${
        prop.status === "win"
          ? "bg-green-100 text-green-700"
          : prop.status === "loss"
          ? "bg-red-100 text-red-700"
          : prop.status === "push"
          ? "bg-yellow-100 text-yellow-700"
          : prop.status === "expired"
          ? "bg-gray-200 text-gray-500 italic"
          : "bg-gray-100 text-gray-600"
      }`}
                  >
                    {prop.status || "Pending"}
                  </span>
                </td>

                <td className="px-4 py-2">{prop.over_under}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan="6" className="px-4 py-4 text-center text-gray-500">
                No props for this date
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const todayString = format(new Date(), "yyyy-MM-dd");
  const isTodaySelected = format(selectedDateObj, "yyyy-MM-dd") === todayString;

  return (
    <div className="flex flex-col gap-6">
      {/* Calendar + Props Table */}
      <div className="flex flex-row gap-8">
        <div>
          <h2 className="text-lg font-semibold">Select a Date</h2>
          <Calendar
            mode="single"
            selected={selectedDateObj}
            onSelect={setSelectedDate}
            className="rounded-md border"
          />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold mb-2">
            {isTodaySelected
              ? "Today's Player Props"
              : `Player Props for ${formattedDate}`}
          </h2>
          {renderPropsTable(filteredProps)}
        </div>
      </div>
    </div>
  );
}
