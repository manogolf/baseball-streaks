# backend/scripts/shared/supabase_utils.py

import os
from functools import lru_cache

# Optional for local dev; harmless in prod
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

@lru_cache(maxsize=1)
def get_supabase():
    """
    Lazily create a single Supabase client using the SERVICE ROLE key.
    Raises if required env vars are missing.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise EnvironmentError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    from supabase import create_client
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# Back-compat for older code: still allow `from ... import supabase`
# (This will create the client at import time; safe on server where env is set.)
try:
    supabase = get_supabase()
except Exception:
    # If env isn't set in some contexts, leave it None to avoid crashing on import.
    supabase = None
