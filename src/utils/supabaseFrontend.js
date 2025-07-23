// File: src/utils/supabaseFrontend.js

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Missing frontend Supabase env vars.");
}

export const supabase = createClient(supabaseUrl, supabaseKey);
