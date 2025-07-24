// pages/api/prepareProp.js
import { supabase } from "../../../backend/scripts/shared/supabaseUtils.js";
import { preparePropSubmission } from "../../../shared/playerUtilsFrontend.js/index.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const input = JSON.parse(req.body);

    const propObject = await preparePropSubmission({
      supabase,
      ...input,
    });

    res.status(200).json(propObject);
  } catch (err) {
    console.error("❌ Error in /api/prepareProp:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
