// fetchPlayerStats.js
import fetch from "node-fetch";

export async function fetchPlayerStats(playerId, year = null) {
  const groupTypes = ["hitting", "pitching"];
  const results = {};

  for (const group of groupTypes) {
    const seasonStatsUrl = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&season=${year}&group=${group}`;
    const careerStatsUrl = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=career&group=${group}`;

    try {
      const [seasonRes, careerRes] = await Promise.all([
        fetch(seasonStatsUrl).then((res) => res.json()),
        fetch(careerStatsUrl).then((res) => res.json()),
      ]);

      if (seasonRes?.stats?.[0]?.splits?.[0]?.stat) {
        results[`${group}_season`] = seasonRes.stats[0].splits[0].stat;
      }

      if (careerRes?.stats?.[0]?.splits?.[0]?.stat) {
        results[`${group}_career`] = careerRes.stats[0].splits[0].stat;
      }
    } catch (err) {
      console.warn(
        `⚠️ Failed to fetch ${group} stats for ${playerId}:`,
        err.message
      );
    }
  }

  return results;
}
