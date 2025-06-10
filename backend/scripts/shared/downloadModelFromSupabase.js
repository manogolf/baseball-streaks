import { supabase } from "../shared/supabaseUtils.js";
import fs from "fs";
import https from "https";
import path from "path";

export async function downloadModelFromSupabase(filename, localPath) {
  const MAX_RETRIES = 3;
  let attempts = 0;

  // Ensure target folder exists
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  // Remove any stale copy from earlier runs
  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

  while (attempts < MAX_RETRIES) {
    try {
      const { data, error } = await supabase.storage
        .from("2025.05.23.mlb-models")
        .createSignedUrl(filename, 60);

      const signedUrl = data?.signedUrl;

      if (error || !signedUrl) {
        throw new Error(
          `Supabase signed URL error: ${
            error?.message || "No signed URL returned"
          }`
        );
      }

      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(localPath);
        https
          .get(signedUrl, (response) => {
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

      // Confirm file exists after write
      if (fs.existsSync(localPath)) {
        console.log(`✅ Downloaded ${filename}`);
        return;
      } else {
        throw new Error(`File missing after supposed download: ${filename}`);
      }
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
        await new Promise((r) => setTimeout(r, 1000 * attempts)); // exponential backoff
      }
    }
  }

  // Final check: if still missing, hard fail
  if (!fs.existsSync(localPath)) {
    throw new Error(
      `❌ ${filename} failed to download after retries and no local file found.`
    );
  }
}
