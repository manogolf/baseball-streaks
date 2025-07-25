// backend/services/preparePropSubmission.js

export default async function preparePropSubmission({
  playerName,
  teamAbbr,
  propType,
  line,
  overUnder,
  gameDate,
}) {
  console.log("🛠️ preparePropSubmission called with:", {
    playerName,
    teamAbbr,
    propType,
    line,
    overUnder,
    gameDate,
  });

  // Temporary stub logic
  return {
    message: "Stub response from preparePropSubmission",
    data: {
      playerName,
      teamAbbr,
      propType,
      line,
      overUnder,
      gameDate,
    },
  };
}
