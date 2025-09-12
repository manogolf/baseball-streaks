# backend/scripts/shared/supabase_utils.py
from __future__ import annotations
import os
from functools import lru_cache

# Optional for local dev; harmless in CI/Prod
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

def _load_env() -> tuple[str, str]:
    """
    Resolve Supabase credentials from env. Accepts any of:
      - SUPABASE_KEY
      - SUPABASE_SERVICE_ROLE
      - SUPABASE_SERVICE_ROLE_KEY
    """
    url = os.getenv("SUPABASE_URL")
    key = (
        os.getenv("SUPABASE_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    )
    if not url or not key:
        raise RuntimeError(
            "Missing Supabase env. Set SUPABASE_URL and SUPABASE_KEY "
            "(or SUPABASE_SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY)."
        )
    return url, key

@lru_cache(maxsize=1)
def get_supabase():
    """ Lazily create a single Supabase client. Raises only when called. """
    from supabase import create_client  # import here to keep errors clear
    url, key = _load_env()
    return create_client(url, key)

# Export a client if env is set; otherwise leave None so import doesn't crash.
try:
    supabase = get_supabase()
except Exception:
    supabase = None
