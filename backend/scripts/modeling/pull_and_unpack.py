# backend/scripts/modeling/pull_and_unpack.py
import os, sys, tarfile, tempfile, requests, time
from pathlib import Path
from supabase import create_client

# load .env if present
try:
    from dotenv import load_dotenv
    for p in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if p.exists():
            load_dotenv(p, override=False)
except Exception:
    pass

MODELS_DIR = Path(os.getenv("MODELS_DIR", "/var/data/models")).resolve()
BUCKET     = os.getenv("MODELS_BUCKET", "models")
OBJECT     = os.getenv("BUNDLE_OBJECT", "models_bundle.tgz")

PIDDIR = MODELS_DIR / "pids"
LOCK   = PIDDIR / "pull_and_unpack.lock"

def _signed_url(sb, bucket: str, path: str) -> str | None:
    res = sb.storage.from_(bucket).create_signed_url(path, 3600)
    if isinstance(res, dict):
        return res.get("signedURL") or res.get("signedUrl")
    return getattr(res, "signed_url", None) or getattr(res, "signedURL", None)

def main() -> int:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb  = create_client(url, key)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    PIDDIR.mkdir(parents=True, exist_ok=True)

    if LOCK.exists():
        print("Another sync is running; exiting.")
        return 0
    LOCK.write_text(f"{int(time.time())}\n")

    try:
        signed = _signed_url(sb, BUCKET, OBJECT)
        if not signed:
            raise RuntimeError("Could not create signed URL")

        print(f"⬇️  downloading {BUCKET}/{OBJECT}")
        with requests.get(signed, stream=True, timeout=120) as r:
            r.raise_for_status()
            with tempfile.NamedTemporaryFile(delete=False) as tmpf:
                for chunk in r.iter_content(1024 * 256):
                    if chunk:
                        tmpf.write(chunk)
                tar_path = Path(tmpf.name)

        print(f"🗜️  unpacking into {MODELS_DIR}")
        with tarfile.open(tar_path, "r:gz") as tar:
            tar.extractall(MODELS_DIR)

        tar_path.unlink(missing_ok=True)
        print("✅ sync complete")
        return 0
    finally:
        try:
            LOCK.unlink()
        except Exception:
            pass

if __name__ == "__main__":
    sys.exit(main())
