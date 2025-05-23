import { supabase } from "./supabaseUtils.js";
import fs from "fs";
import https from "https";

export async function downloadModelFromSupabase(filename, localPath) {
  const { data, error } = await supabase.storage
    .from("mlb-models")
    .createSignedUrl(filename, 60); // valid for 60 seconds

  if (error) {
    throw new Error(`Supabase signed URL error: ${error.message}`);
  }

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
