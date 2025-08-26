#!/usr/bin/env bash
set -euo pipefail

REPO="${MODELS_REPO:?set MODELS_REPO like owner/repo}"
DEST="${MODELS_DIR:-/var/data/models}"
TAG="${MODELS_TAG:-models-latest}"   # moving tag by default
USE_LATEST="${USE_LATEST_API:-0}"

# Optional auth header (only if token present)
AUTH=()
[ -n "${GH_TOKEN:-}" ] && AUTH=(-H "Authorization: token $GH_TOKEN")
if [ ${#AUTH[@]} -eq 0 ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: token $GITHUB_TOKEN")
fi

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
TMP_EXTRACT="$TMPROOT/extract"
mkdir -p "$DEST" "$TMP_EXTRACT"

# Pick endpoint
API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
[ "$USE_LATEST" = "1" ] && API_URL="https://api.github.com/repos/$REPO/releases/latest"

# Fetch release JSON
curl -fsSL "${AUTH[@]}" "$API_URL" > "$TMPROOT/release.json"

# Resolve the true tag (for /latest)
RESOLVED_TAG="$(python3 - <<'PY'
import json,sys; d=json.load(open(sys.argv[1])); print(d.get("tag_name",""))
PY
"$TMPROOT/release.json")"
[ -n "$RESOLVED_TAG" ] && TAG="$RESOLVED_TAG"

# Find a tar asset URL
ASSET_URL="$(python3 - <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for a in d.get("assets",[]):
    n=a.get("name","")
    if n.endswith((".tar.gz",".tgz",".tar.zst")):
        print(a["browser_download_url"]); break
PY
"$TMPROOT/release.json")"
[ -n "$ASSET_URL" ] || { echo "No tar asset found for tag $TAG"; exit 1; }

echo "Downloading: $ASSET_URL"
DL="$TMPROOT/models.tar"
if [[ "$ASSET_URL" =~ \.zst$ ]]; then
  curl -fsSL "${AUTH[@]}" "$ASSET_URL" -o "$DL.zst"
  zstdcat "$DL.zst" | tar -x -C "$TMP_EXTRACT" --strip-components=1 || zstdcat "$DL.zst" | tar -x -C "$TMP_EXTRACT"
else
  curl -fsSL "${AUTH[@]}" "$ASSET_URL" -o "$DL.gz"
  tar -xzf "$DL.gz" -C "$TMP_EXTRACT" --strip-components=1 || tar -xzf "$DL.gz" -C "$TMP_EXTRACT"
fi

# Flatten nested 'latest/' if present
if [ -d "$TMP_EXTRACT/latest" ]; then
  shopt -s dotglob
  mv "$TMP_EXTRACT/latest"/* "$TMP_EXTRACT"/
  rmdir "$TMP_EXTRACT/latest"
  shopt -u dotglob
fi

# Remove macOS AppleDouble junk
find "$TMP_EXTRACT" -type f -name '._*' -delete

# Write version marker
echo "$TAG" > "$TMP_EXTRACT/.version"

# Atomic swap into DEST/latest
rm -rf "$DEST/latest.prev"
[ -d "$DEST/latest" ] && mv "$DEST/latest" "$DEST/latest.prev"
mv "$TMP_EXTRACT" "$DEST/latest"

echo "Installed tag: $TAG -> $DEST/latest"
find "$DEST/latest" -maxdepth 1 -type f -name '*.joblib' -printf ' - %f\n' 2>/dev/null || true
