#!/bin/bash
set -euo pipefail

APP_DIR="claude-settings-ui"
DIST_DIR="$APP_DIR/dist"

cd "$(dirname "$0")/.."

# Check clean working tree
if ! git diff-index --quiet HEAD --; then
  echo "ERROR: Working tree not clean. Commit or stash changes first."
  exit 1
fi

# Get version
VERSION=$(node -p "require('./$APP_DIR/package.json').version")
TAG="v$VERSION"

echo "==> Building $APP_DIR $TAG"

# Build
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
(cd "$APP_DIR" && npm run dist)

# Find artifacts
DMG=$(ls "$DIST_DIR"/*.dmg 2>/dev/null | head -1)
ZIP=$(ls "$DIST_DIR"/*.zip 2>/dev/null | head -1)

if [ -z "$DMG" ]; then
  echo "ERROR: No DMG found in $DIST_DIR"
  exit 1
fi

echo "==> DMG: $DMG"
echo "==> ZIP: $ZIP"

# Tag
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "ERROR: Tag $TAG already exists."
  exit 1
fi

git tag "$TAG"
git push origin "$TAG"

# Release
echo "==> Creating GitHub Release $TAG"
gh release create "$TAG" "$DMG" "$ZIP" \
  --title "$TAG" \
  --notes "macOS build of Claude Settings $TAG.

- \`$(basename "$DMG")\` — DMG installer
- \`$(basename "$ZIP")\` — ZIP archive"

echo "==> Done: https://github.com/jojofran/tools/releases/tag/$TAG"
