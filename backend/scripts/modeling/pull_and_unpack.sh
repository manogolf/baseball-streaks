#  backend/scripts/modeling/pull_and_unpack.sh

#!/usr/bin/env bash
set -euo pipefail

REPO="${MODELS_REPO:?set MODELS_REPO like owner/repo}"
DEST="${MODELS_DIR:-/var/data/models}"
TAG="${MODELS_TAG:-models-latest}"   # or omit to use "latest" endpoint
TMP="$(mktemp -d)"

mkdir -p "$DEST"

if [ "${USE_LATEST_API:-0}" = "1" ]; then
  # use the latest release endpoint
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  # use an explicit tag (default: models-latest)
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

ASSET_URL="$(curl -fsSL -H "Authorization: token $GH_TOKEN" "$API_URL" \
  | python3 - <<'PY'
import sys, json
d=json.load(sys.stdin)
assets=d.get("assets",[])
for a in assets:
    n=a.get("name","")
    if n.endswith(".tar.gz"):
        print(a["browser_download_url"])
        break
PY
)"

[ -n "$ASSET_URL" ] || { echo "No tar.gz asset found on $API_URL"; exit 1; }

echo "Downloading: $ASSET_URL"
curl -fsSL -H "Authorization: token $GH_TOKEN" "$ASSET_URL" -o "$TMP/models.tar.gz"

# unpack and strip the top-level "models" folder
tar -xzf "$TMP/models.tar.gz" -C "$DEST" --strip-components=1

# quick verification
echo "Unpacked model files:"
find "$DEST" -maxdepth 2 -type f -name '*.joblib' -print | sed 's#^# - #'
