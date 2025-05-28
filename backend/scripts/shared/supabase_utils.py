# backend/scripts/shared/supabase_utils.py

import os
from supabase import create_client
from dotenv import load_dotenv

# Load from .env if present
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise EnvironmentError("❌ Missing Supabase environment variables.")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
