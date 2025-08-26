#!/usr/bin/env bash
set -euo pipefail

# ── Config (env-driven) ─────────────────────────────────────────────────────────
REPO="${MODELS_REPO:?set MODELS_REPO like owner/repo (e.g. manogolf/baseball-streaks)}"
DEST="${MODELS_DIR:-/var/data/models}"
TAG="${MODELS_TAG:-models-latest}"            # moving tag by default
USE_LATEST="${USE_LATEST_API:-0}"             # set to 1 to use /releases/latest

# Optional auth header (repo can be public; tokens are only used if present)
AUTH=()
if [ -n "${GH_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: token $GH_TOKEN")
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: token $GITHUB_TOKEN")
fi

# ── Temp workspace ──────────────────────────────────────────────────────────────
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
TMP_EXTRACT="$TMPROOT/extract"
mkdir -p "$DEST" "$TMP_EXTRACT"

# ── Resolve release → asset URL ────────────────────────────────────────────────
API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
[ "$USE_LATEST" = "1" ] && API_URL="https://api.github.com/repos/$REPO/releases/latest"

curl -fsSL "${AUTH[@]}" "$API_URL" > "$TMPROOT/release.json"

# If using /latest, capture the actual tag_name
RESOLVED_TAG="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("tag_name",""))' "$TMPROOT/release.json")"
[ -n "$RESOLVED_TAG" ] && TAG="$RESOLVED_TAG"

ASSET_URL="$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for a in d.get("assets",[]):
    n=a.get("name","")
    if n.endswith((".tar.gz",".tgz",".tar.zst")):
        print(a["browser_download_url"]); break' "$TMPROOT/release.json")"

[ -n "$ASSET_URL" ] || { echo "❌ No .tar.gz/.tgz/.zst asset found for tag: $TAG"; exit 1; }
echo "⬇️  Downloading: $ASSET_URL"

# ── Download & extract to staging ──────────────────────────────────────────────
DL="$TMPROOT/models.tar"
if [[ "$ASSET_URL" =~ \.zst$ ]]; then
  curl -fsSL "${AUTH[@]}" "$ASSET_URL" -o "$DL.zst"
  # requires zstd; if unavailable, publish .tar.gz instead
  zstdcat "$DL.zst" | tar -x -C "$TMP_EXTRACT" --strip-components=1 || zstdcat "$DL.zst" | tar -x -C "$TMP_EXTRACT"
else
  curl -fsSL "${AUTH[@]}" "$ASSET_URL" -o "$DL.gz"
  tar -xzf "$DL.gz" -C "$TMP_EXTRACT" --strip-components=1 || tar -xzf "$DL.gz" -C "$TMP_EXTRACT"
fi

# If the tar nests a top-level "latest/" folder, flatten it
if [ -d "$TMP_EXTRACT/latest" ]; then
  shopt -s dotglob
  mv "$TMP_EXTRACT/latest"/* "$TMP_EXTRACT"/
  rmdir "$TMP_EXTRACT/latest"
  shopt -u dotglob
fi

# Remove macOS AppleDouble junk
find "$TMP_EXTRACT" -type f -name '._*' -delete

# ── Version marker & atomic swap ───────────────────────────────────────────────
echo "$TAG" > "$TMP_EXTRACT/.version"

rm -rf "$DEST/latest.prev"
[ -d "$DEST/latest" ] && mv "$DEST/latest" "$DEST/latest.prev"
mv "$TMP_EXTRACT" "$DEST/latest"

echo "✅ Installed tag: $TAG → $DEST/latest"
# quick glance
find "$DEST/latest" -maxdepth 1 -type f -name '*.joblib' -printf ' - %f\n' 2>/dev/null || true
