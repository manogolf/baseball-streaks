import { useEffect, useState } from "react";
import { format, isValid } from "date-fns";
import {
  todayET,
  currentTimeET,
  toISODate,
} from "../scripts/shared/timeUtils.js";
import { supabase } from "../utils/supabaseUtils.js";
import Calendar from "./ui/calendar.js";
import AccuracyByPropType from "./AccuracyByPropType.js"; // Adjust the path if necessary
import { getPropDisplayLabel } from "../scripts/shared/propUtils.js";

export default function PropTracker() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [allProps, setAllProps] = useState([]);
  const [filteredProps, setFilteredProps] = useState([]);

  useEffect(() => {
    if (!selectedDate) return;

    const selectedDateObj =
      typeof selectedDate === "string"
        ? new Date(selectedDate + "T00:00:00")
        : selectedDate;

    if (!isValid(selectedDateObj)) {
      console.warn("Invalid selected date:", selectedDate);
      return;
    }

    const selectedDateString = format(selectedDateObj, "yyyy-MM-dd");

    const fetchProps = async () => {
      const { data, error } = await supabase
        .from("player_props")
        .select("*")
        .eq("game_date", selectedDateString);

      if (error) {
        console.error("Error fetching props:", error);
      } else {
        setAllProps(data);
        setFilteredProps(data); // Directly set filtered props since already filtered by date
      }
    };

    fetchProps();
  }, [selectedDate]);

  const selectedDateObj =
    typeof selectedDate === "string"
      ? new Date(selectedDate + "T00:00:00")
      : selectedDate;

  const formattedDate = isValid(selectedDateObj)
    ? format(selectedDateObj, "PPP")
    : "Invalid Date";

  const renderPropsTable = (props) => (
    <div className="bg-blue-50 shadow-md rounded-lg overflow-hidden border">
      <table className="w-full text-sm text-left">
        <thead className="bg-gray-50">
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
                <td className="px-4 py-2">
                  {getPropDisplayLabel(prop.prop_type)}
                </td>
                <td className="px-4 py-2">{prop.prop_value}</td>
                <td className="px-4 py-2">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-semibold ${
                      prop.outcome === "win"
                        ? "bg-green-100 text-green-700"
                        : prop.outcome === "loss"
                        ? "bg-red-100 text-red-700"
                        : prop.outcome === "push"
                        ? "bg-blue-100 text-blue-700"
                        : prop.status === "expired"
                        ? "bg-gray-200 text-gray-500 italic"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {prop.outcome
                      ? prop.outcome.charAt(0).toUpperCase() +
                        prop.outcome.slice(1)
                      : prop.status === "expired"
                      ? "Expired"
                      : "Pending"}
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
          <AccuracyByPropType selectedDate={selectedDateObj} />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold mb-2">
            {isTodaySelected
              ? "Player Props for Selected Date"
              : `Player Props for ${formattedDate}`}
          </h2>
          {renderPropsTable(filteredProps)}
        </div>
      </div>
    </div>
  );
}
