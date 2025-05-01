import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://cnwwhhmpashijqbspvhf.supabase.co';     // copy this from Settings → API
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNud3doaG1wYXNoaWpxYnNwdmhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ2NjUzMDAsImV4cCI6MjA2MDI0MTMwMH0.Y5gOSLaZNftcaDWy4I5PeA__6DIQpG2eWkGqQh0wXwQ';                  // also from Settings → API

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
