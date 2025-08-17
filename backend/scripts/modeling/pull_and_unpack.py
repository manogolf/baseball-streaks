# backend/scripts/models/pull_and_unpack.py
import os, sys, tarfile, tempfile, requests, time, shutil
from pathlib import Path
from supabase import create_client

BUCKET = os.environ.get("MODELS_BUCKET", "models")
OBJECT = os.environ.get("BUNDLE_OBJECT", "models_bundle.tgz")
TARGET = Path(os.environ.get("MODELS_DIR", "/var/data/models")).resolve()
PIDDIR = TARGET / "pids"
LOCK   = PIDDIR / "pull.lock"

def _signed_url(sb, bucket: str, path: str) -> str:
    res = sb.storage.from_(bucket).create_signed_url(path, 3600)
    return res["signedURL"]

def main():
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb  = create_client(url, key)

    PIDDIR.mkdir(parents=True, exist_ok=True)
    if LOCK.exists():
        print("Another sync is running; exiting.")
        return 0
    LOCK.write_text(f"{int(time.time())}\n")

    try:
        signed = _signed_url(sb, BUCKET, OBJECT)
        print(f"⬇️  downloading {BUCKET}/{OBJECT}")
        with requests.get(signed, stream=True, timeout=120) as r:
            r.raise_for_status()
            with tempfile.NamedTemporaryFile(delete=False) as tmpf:
                for chunk in r.iter_content(1024*256):
                    if chunk:
                        tmpf.write(chunk)
                tar_path = tmpf.name

        # extract to staging then rsync-like replace
        staging = TARGET.parent / (TARGET.name + ".staging")
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True, exist_ok=True)

        with tarfile.open(tar_path, "r:gz") as tar:
            tar.extractall(staging)

        # move into place (atomic-ish)
        # Copy tree to TARGET but keep existing dirs (predictions may read)
        for name in ("latest", "archive", "feature_metadata.json"):
            src = staging / name
            dst = TARGET / name
            if src.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
                # copy files over
                for p in src.rglob("*"):
                    if p.is_dir(): continue
                    out = dst / p.relative_to(src)
                    out.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, out)
            elif src.exists():
                shutil.copy2(src, dst)

        print("✅ sync complete")
        return 0
    finally:
        try: LOCK.unlink()
        except: pass

if __name__ == "__main__":
    sys.exit(main())
