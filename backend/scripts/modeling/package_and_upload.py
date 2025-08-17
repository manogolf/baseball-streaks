# scripts/models/package_and_upload.py
import os, io, tarfile, time, json
from pathlib import Path
from supabase import create_client

# load .env for Python
try:
    from dotenv import load_dotenv
    for p in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if p.exists():
            load_dotenv(p, override=False)
except Exception:
    pass  # keep going if python-dotenv isn't installed


MODELS_DIR = Path(os.environ.get("MODELS_DIR", "./models_out")).resolve()
BUNDLE_NAME = os.environ.get("BUNDLE_NAME", "models_bundle.tgz")
BUCKET      = os.environ.get("MODELS_BUCKET", "models")
OBJECT_PATH = os.environ.get("BUNDLE_OBJECT", "models_bundle.tgz")

def _tar_gz_dir(root: Path) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in sorted(root.rglob("*")):
            arc = p.relative_to(root).as_posix()
            tar.add(p, arcname=arc)
    return buf.getvalue()

def main():
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb = create_client(url, key)

    assert MODELS_DIR.exists(), f"{MODELS_DIR} not found"
    # sanity: must include latest + archive at minimum
    for sub in ("latest", "archive"):
        assert (MODELS_DIR / sub).exists(), f"{sub} missing in {MODELS_DIR}"

    blob = _tar_gz_dir(MODELS_DIR)
    print(f"📦 built tarball: {len(blob)} bytes")

    # upload (overwrite)
    print(f"⬆️  uploading to storage: {BUCKET}/{OBJECT_PATH}")
    sb.storage.from_(BUCKET).upload(OBJECT_PATH, blob, {
        "contentType": "application/gzip",
        "upsert": "true"
    })
    # write a tiny manifest too (handy for debugging)
    stamp = {
        "uploaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "size_bytes": len(blob)
    }
    sb.storage.from_(BUCKET).upload("manifest.json", json.dumps(stamp).encode("utf-8"), {
        "contentType": "application/json",
        "upsert": "true"
    })
    print("✅ upload complete")

if __name__ == "__main__":
    main()
