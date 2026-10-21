#!/usr/bin/env bash
# Builds the macOS app (Apple Silicon) from Linux: release/Musikatu-<version>-arm64-mac.zip.
# electron-builder can only sign on a Mac, and Apple Silicon refuses unsigned apps, so the
# bundle is ad-hoc signed with rcodesign (https://github.com/indygreg/apple-platform-rs).
#   RCODESIGN=/path/to/rcodesign bash scripts/dist-mac.sh
# On a Mac, `npx electron-builder --mac --arm64` does all of this (dmg + zip) by itself.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RCODESIGN="${RCODESIGN:-rcodesign}"
command -v "$RCODESIGN" >/dev/null || { echo "rcodesign not found: install it or set RCODESIGN" >&2; exit 1; }
VERSION="$(node -p "require('$ROOT/package.json').version")"
APP="$ROOT/release/mac-arm64/Musikatu.app"
ZIP="$ROOT/release/Musikatu-$VERSION-arm64-mac.zip"

cd "$ROOT"
npm run build
rm -rf "$ROOT/release/mac-arm64"
npx electron-builder --mac --dir --arm64
"$RCODESIGN" sign "$APP"
# zip -y keeps the framework symlinks (Versions/Current); following them breaks the bundle.
rm -f "$ZIP"
(cd "$(dirname "$APP")" && zip -qry -9 "$ZIP" "$(basename "$APP")")
echo "$ZIP"
