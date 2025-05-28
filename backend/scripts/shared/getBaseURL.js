export function getBaseURL() {
  const isLocal = window.location.hostname === "localhost";
  return isLocal
    ? "http://localhost:8001" // 🛠 Local FastAPI server
    : "https://baseball-streaks-sq44.onrender.com"; // 🔥 Replace with your actual Render domain
}
