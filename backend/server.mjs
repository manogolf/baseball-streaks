// backend/server.mjs
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import preparePropSubmission from "./services/preparePropSubmission.mjs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.post("/api/prepareProp", async (req, res) => {
  try {
    const { playerName, teamAbbr, propType, line, overUnder, gameDate } =
      req.body;

    const result = await preparePropSubmission({
      playerName,
      teamAbbr,
      propType,
      line,
      overUnder,
      gameDate,
    });

    res.json(result);
  } catch (err) {
    console.error("❌ API Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API server running on port ${PORT}`);
});
