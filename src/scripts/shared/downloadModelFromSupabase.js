import { supabase } from "./supabaseUtils.js";
import fs, { mkdirSync } from "fs";
import https from "https";
import path from "path";

export async function downloadModelFromSupabase(filename, localPath) {
  const MAX_RETRIES = 3;
  let attempts = 0;

  // ✅ Ensure target folder exists
  mkdirSync(path.dirname(localPath), { recursive: true });

  while (attempts < MAX_RETRIES) {
    try {
      const { data, error } = await supabase.storage
        .from("2025.05.23.mlb-models")
        .createSignedUrl(filename, 60);

      if (error || !data?.signedUrl) {
        throw new Error(
          `Supabase signed URL error: ${
            error?.message || "No signed URL returned"
          }`
        );
      }

      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(localPath);
        https
          .get(data.signedUrl, (response) => {
            if (response.statusCode !== 200) {
              reject(
                new Error(`HTTP ${response.statusCode} during model download`)
              );
              return;
            }
            response.pipe(file);
            file.on("finish", () => file.close(resolve));
          })
          .on("error", reject);
      });

      console.log(`✅ Downloaded ${filename}`);
      return;
    } catch (err) {
      attempts += 1;
      console.warn(
        `⚠️ Attempt ${attempts} failed for ${filename}: ${err.message}`
      );
      if (attempts >= MAX_RETRIES) {
        console.error(
          `❌ Error downloading ${filename} after ${MAX_RETRIES} attempts: ${err.message}`
        );
      } else {
        await new Promise((r) => setTimeout(r, 1000 * attempts)); // Exponential backoff
      }
    }
  }
}
