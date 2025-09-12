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
    Resolve Supabase credentials from environment.
    Accepts SUPABASE_KEY, SUPABASE_SERVICE_ROLE, or SUPABASE_SERVICE_ROLE_KEY.
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
    """
    Lazily create a single Supabase client. Raises if env is missing.
    """
    from supabase import create_client  # import here to make errors clearer
    url, key = _load_env()
    return create_client(url, key)


# Export a live client at import time so callers can:
#   from scripts.shared.supabase_utils import supabase
supabase = get_supabase()
