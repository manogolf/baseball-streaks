// src/utils/fetchSchedule.js
import fetch from "node-fetch";

export async function fetchSchedule(targetDate) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDate}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error(`❌ Failed to fetch schedule for ${targetDate}`);
    return { data: [], error: `HTTP ${res.status}` };
  }

  const json = await res.json();
  const games = json.dates?.[0]?.games || [];

  return { data: games, error: null };
}
