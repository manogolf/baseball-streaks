import { useEffect, useState } from "react";
import { format, isValid } from "date-fns";
import { todayET, currentTimeET, toISODate } from "../utils/timeUtils.js";
import { supabase } from "../lib/supabaseClient.js";
import Calendar from "./ui/calendar.jsx";

function AccuracyByPropType({ selectedDate }) {
  const [accuracyData, setAccuracyData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!selectedDate) return;

    const fetchAccuracy = async () => {
      setLoading(true);
      const { data, error } = await supabase.rpc("get_daily_prop_accuracy", {
        target_date: toISODate(selectedDate),
      });

      if (error) {
        console.error("❌ Failed to fetch accuracy data:", error.message);
        setAccuracyData([]);
      } else {
        setAccuracyData(data);
      }
      setLoading(false);
    };

    fetchAccuracy();
  }, [selectedDate]);

  return (
    <div className="mt-12 border rounded-md p-3 shadow-sm bg-white w-full max-w-sm">
      <h3 className="text-lg font-semibold mb-2">Prediction Accuracy</h3>
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : accuracyData.length === 0 ? (
        <p className="text-sm text-gray-500">No predictions for this day.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b">
              <th className="text-left py-1">Prop Type</th>
              <th className="text-right py-1">Total</th>
              <th className="text-right py-1">Correct</th>
              <th className="text-right py-1">Accuracy (%)</th>
            </tr>
          </thead>
          <tbody>
            {accuracyData.map((row) => (
              <tr key={row.prop_type} className="border-b">
                <td className="py-1">{row.prop_type}</td>
                <td className="text-right py-1">{row.total}</td>
                <td className="text-right py-1">{row.correct}</td>
                <td className="text-right py-1">{row.accuracy_pct}</td>
              </tr>
            ))}
            {accuracyData.length > 1 && (
              <tr className="border-t font-semibold">
                <td className="py-1">Total</td>
                <td className="text-right py-1">
                  {accuracyData.reduce((sum, row) => sum + row.total, 0)}
                </td>
                <td className="text-right py-1">
                  {accuracyData.reduce((sum, row) => sum + row.correct, 0)}
                </td>
                <td className="text-right py-1">
                  {(
                    (accuracyData.reduce((sum, row) => sum + row.correct, 0) /
                      accuracyData.reduce((sum, row) => sum + row.total, 0)) *
                    100
                  ).toFixed(1)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

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
              ? "Today's Player Props"
              : `Player Props for ${formattedDate}`}
          </h2>
          {renderPropsTable(filteredProps)}
        </div>
      </div>
    </div>
  );
}
