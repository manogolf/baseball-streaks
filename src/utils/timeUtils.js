// src/utils/timeUtils.js
import { DateTime } from "luxon";

export const nowET = () => DateTime.now().setZone("America/New_York");

export const todayET = () => nowET().toISODate(); // e.g. '2025-05-07'
export const currentTimeET = () => nowET().toFormat("HH:mm"); // e.g. '21:45'
