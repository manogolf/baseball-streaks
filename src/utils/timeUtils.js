import { DateTime } from "luxon";

// Core time references (Eastern Time)
export const nowET = () => DateTime.now().setZone("America/New_York");

export const todayET = () => nowET().toISODate(); // e.g. '2025-05-07'
export const currentTimeET = () => nowET().toFormat("HH:mm"); // e.g. '21:38'

// Convert ISO string (UTC) to Eastern Date
export const getEasternDateFromISO = (isoString) =>
  DateTime.fromISO(isoString, { zone: "utc" })
    .setZone("America/New_York")
    .toISODate();

export const toISODate = (jsDate) => DateTime.fromJSDate(jsDate).toISODate();

// Format game start time in both ET and local time
export const formatGameTime = (utcDateStr) => {
  const et = DateTime.fromISO(utcDateStr, { zone: "utc" }).setZone(
    "America/New_York"
  );
  const local = et.setZone(DateTime.local().zoneName);

  return {
    etTime: et.toFormat("hh:mm a"),
    localTime: local.toFormat("hh:mm a"),
  };
};
