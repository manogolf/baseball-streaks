#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "[pull_and_unpack] ERROR line $LINENO: $BASH_COMMAND" >&2' ERR

REPO="${MODELS_REPO:?set MODELS_REPO like owner/repo}"
DEST="${MODELS_DIR:-/var/data/models}"
TAG="${MODELS_TAG:-models-latest}"
USE_LATEST="${USE_LATEST_API:-0}"

mkdir -p "$DEST"
umask 002

# ---- lock to avoid concurrent predeploys ----
LOCK="$DEST/.update.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "[pull_and_unpack] another update in progress, exiting"; exit 0; }

# ---- skip if already installed ----
if [[ -f "$DEST/latest/.version" ]]; then
  INSTALLED="$(cat "$DEST/latest/.version" || true)"
  if [[ "$INSTALLED" == "$TAG" ]]; then
    echo "✅ Already installed tag: $TAG → $DEST/latest (skip)"
    exit 0
  fi
fi

# ---- auth header only if token present ----
AUTH=()
[[ -n "${GH_TOKEN:-}"      ]] && AUTH=(-H "Authorization: token $GH_TOKEN")
[[ ${#AUTH[@]} -eq 0 && -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: token $GITHUB_TOKEN")

# ---- resolve API endpoint ----
if [[ "$USE_LATEST" == "1" ]]; then
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
JSON="$TMPROOT/release.json"

# robust curl: retry on network & 5xx, backoff a bit
curl -fsSL "${AUTH[@]}" \
  --retry 5 --retry-all-errors --retry-delay 2 \
  -H "Accept: application/vnd.github+json" \
  "$API_URL" -o "$JSON"

ASSET_URL="$(python3 - <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for a in d.get("assets",[]):
    if a.get("name","").endswith((".tar.gz",".tgz")):
        print(a["browser_download_url"]); break
PY
"$JSON")"

[[ -n "$ASSET_URL" ]] || { echo "No tarball asset found on $API_URL"; exit 1; }

echo "⬇️  Downloading: $ASSET_URL"
TAR="$TMPROOT/models.tar.gz"
curl -fL --retry 5 --retry-all-errors --retry-delay 2 \
  -o "$TAR" "$ASSET_URL"

EXTRACT="$TMPROOT/extract"
mkdir -p "$EXTRACT"

# suppress macOS xattr chatter; strip top-level
tar --warning=no-unknown-keyword \
    -xzf "$TAR" -C "$EXTRACT" --strip-components=1

# basic sanity: at least one joblib
if ! find "$EXTRACT" -maxdepth 1 -type f -name '*.joblib' | head -n1 | grep -q .; then
  echo "Tarball sanity check failed: no .joblib files at top level." >&2
  exit 1
fi

echo "$TAG" > "$EXTRACT/.version"

# atomic swap
rm -rf "$DEST/latest.prev"
[[ -d "$DEST/latest" ]] && mv "$DEST/latest" "$DEST/latest.prev"
mv "$EXTRACT" "$DEST/latest"

echo "✅ Installed tag: $TAG → $DEST/latest"
find "$DEST/latest" -maxdepth 1 -type f -name '*.joblib' -printf ' - %f\n' | sort
