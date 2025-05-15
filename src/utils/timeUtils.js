// src/utils/timeUtils.js
import { DateTime } from "luxon";

// 📌 Get Current Time in Eastern Time (ISO String)
export function nowET() {
  return DateTime.now().setZone("America/New_York");
}

// 📌 Get Today’s Date in Eastern Time (YYYY-MM-DD)
export function todayET() {
  return nowET().toISODate();
}

// 📌 Get Current Time of Day in Eastern Time (HH:mm)
export function currentTimeET() {
  return nowET().toFormat("HH:mm");
}

// 📌 Convert Any Date to ISO Date (YYYY-MM-DD)
// Accepts a Date object, ISO string, or Luxon DateTime
export function toISODate(dateInput) {
  if (!dateInput) return null;

  if (typeof dateInput === "string") {
    return DateTime.fromISO(dateInput).toISODate();
  } else if (dateInput instanceof Date) {
    return DateTime.fromJSDate(dateInput).toISODate();
  } else if (DateTime.isDateTime(dateInput)) {
    return dateInput.toISODate();
  }

  console.warn("⚠️ Invalid date input provided to toISODate:", dateInput);
  return null;
}
// ✅ Add this function to support TodayGames.js
export function formatGameTime(isoDateTime) {
  if (!isoDateTime) return { etTime: "", localTime: "" };

  const dt = DateTime.fromISO(isoDateTime);
  return {
    etTime: dt.setZone("America/New_York").toFormat("HH:mm"),
    localTime: dt.toFormat("HH:mm"),
  };
}
