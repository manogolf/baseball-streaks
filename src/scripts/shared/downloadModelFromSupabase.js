import { supabase } from "./supabaseUtils.js";
import fs, { mkdirSync } from "fs";
import https from "https";
import path from "path";

export async function downloadModelFromSupabase(filename, localPath) {
  const { data, error } = await supabase.storage
    .from("2025.05.23.mlb-models")
    .createSignedUrl(filename, 60);

  if (error) {
    throw new Error(`Supabase signed URL error: ${error.message}`);
    console.log("🔗 Signed URL response:", data?.signedUrl);
  }

  // ✅ Ensure target folder exists
  mkdirSync(path.dirname(localPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(localPath);
    https
      .get(data.signedUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download file: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}
