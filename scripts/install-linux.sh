#!/usr/bin/env bash
# Installs the built app (release/linux-unpacked) for the current user — no root needed.
#   bash scripts/install-linux.sh            install / update
#   bash scripts/install-linux.sh --uninstall
set -euo pipefail

APP=earwork-ai
NAME="Earwork AI"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/release/linux-unpacked"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/$APP"
BIN="$HOME/.local/bin/$APP"
DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications/$APP.desktop"
ICON="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps/$APP.png"
SVG="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps/$APP.svg"

refresh() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$(dirname "$DESKTOP")" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$DEST" "$BIN" "$DESKTOP" "$ICON" "$SVG"
  refresh
  echo "Removed $NAME. Your models, stems cache and settings remain in ~/.config/$NAME (delete it to remove them too)."
  exit 0
fi

[[ -x "$SRC/$APP" ]] || { echo "Build first: npm run dist:dir" >&2; exit 1; }

# Replace atomically so a running copy keeps working until it is restarted.
rm -rf "$DEST.new"
cp -a "$SRC" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

mkdir -p "$(dirname "$BIN")" "$(dirname "$DESKTOP")" "$(dirname "$ICON")" "$(dirname "$SVG")"
ln -sf "$DEST/$APP" "$BIN"
install -m 644 "$ROOT/build/icon.png" "$ICON"
install -m 644 "$ROOT/build/icon.svg" "$SVG"

cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=$NAME
GenericName=Transcription workbench
Comment=Slow down, loop and analyse music by ear, with on-device AI instrument separation
Exec=$DEST/$APP %F
Icon=$APP
Terminal=false
Categories=AudioVideo;Audio;Music;
MimeType=audio/mpeg;audio/flac;audio/x-flac;audio/wav;audio/x-wav;audio/ogg;audio/x-vorbis+ogg;audio/opus;audio/mp4;audio/x-m4a;audio/aac;audio/aiff;audio/x-aiff;
Keywords=transcribe;music;slow down;loop;stems;guitar;chords;
StartupWMClass=$APP
DESK

refresh
echo "Installed $NAME → $DEST"
echo "Launch it from your app launcher, or run: $APP [song.mp3]"
